use core_types::activity::ActivityChunk;
use serde_json::{json, Value};

use crate::projection::project_activity_chunks;
use crate::*;

fn source() -> PortableConversationSource {
    PortableConversationSource {
        source_kind: "fixture".to_string(),
        source_session_id: "fixture-session".to_string(),
        source_snapshot: PortableSourceSnapshot {
            algorithm: PortableSourceSnapshotAlgorithm::Sha256,
            digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            observed_bytes: 42,
        },
        parser_version: 1,
        title: Some("A session".to_string()),
        model: Some("model".to_string()),
        source_workspace_hint: Some("/source/only".to_string()),
        started_at: Some("2026-08-25T00:00:00Z".to_string()),
        updated_at: Some("2026-08-25T00:01:00Z".to_string()),
    }
}

fn chunk(index: usize, action_type: &str, function: &str, result: Value) -> ActivityChunk {
    let mut chunk = ActivityChunk::new("fixture-session", action_type, function);
    chunk.chunk_id = format!("chunk-{index}");
    chunk.created_at = format!("2026-08-25T00:00:{index:02}Z");
    chunk.result = result;
    chunk
}

fn empty_manifest() -> PortableLossManifest {
    PortableLossManifest::default()
}

fn manifest(reason: PortableLossReason, count: u64) -> PortableLossManifest {
    let entry = PortableLossEntry {
        reason,
        impact: reason.impact(),
        count,
    };
    let mut manifest = PortableLossManifest {
        fidelity: PortableFidelity::default(),
        entries: vec![entry],
        total_omitted_items: count,
    };
    manifest.fidelity = manifest.computed_fidelity();
    manifest
}

fn exact_project(chunks: Vec<ActivityChunk>) -> Result<PortableConversation, String> {
    project_exact_read(ExactReadOutcome {
        source: source(),
        chunks,
        reader_loss_manifest: empty_manifest(),
    })
}

fn projected_with_manifest(
    chunks: &[ActivityChunk],
    initial_manifest: PortableLossManifest,
) -> PortableConversation {
    project_activity_chunks(source(), chunks, initial_manifest).expect("project fixture")
}

fn settled_tool(index: usize, call_id: &str, output: Value) -> ActivityChunk {
    let mut result = json!({
        "call_id": call_id,
        "raw_tool_name": "Shell",
        "status": "completed",
        "success": true,
    });
    result
        .as_object_mut()
        .expect("object")
        .insert("output".to_string(), output);
    chunk(index, "tool_call", "shell", result)
}

#[test]
fn preserves_visible_messages_without_handoff_truncation() {
    let long = "原文".repeat(2_000);
    let chunks = (0..101)
        .map(|index| {
            chunk(
                index,
                "raw",
                "user_message",
                json!({"message": {"content": format!("{index}:{long}")}}),
            )
        })
        .collect::<Vec<_>>();

    let projected = exact_project(chunks).expect("exact projection");
    assert_eq!(projected.events.len(), 101);
    let PortableEventBody::Message { content, .. } = &projected.events[100].body else {
        panic!("expected message");
    };
    assert_eq!(
        content,
        &vec![PortableContentBlock::Text {
            text: format!("100:{long}")
        }]
    );
    assert_eq!(projected.loss_manifest.total_omitted_items, 0);
}

#[test]
fn preserves_system_developer_and_compaction_as_distinct_context() {
    let projected = exact_project(vec![
        chunk(0, "raw", "system_message", json!({"content": "system"})),
        chunk(
            1,
            "raw",
            "developer_message",
            json!({"content": "developer"}),
        ),
        chunk(
            2,
            "compaction_summary",
            "compaction_summary",
            json!({"content": "summary"}),
        ),
    ])
    .expect("exact projection");

    assert!(matches!(
        projected.events[0].body,
        PortableEventBody::Message {
            role: PortableRole::System,
            ..
        }
    ));
    assert!(matches!(
        projected.events[1].body,
        PortableEventBody::Message {
            role: PortableRole::Developer,
            ..
        }
    ));
    assert!(matches!(
        projected.events[2].body,
        PortableEventBody::CompactionSummary { .. }
    ));
}

#[test]
fn arbitrary_raw_chunks_are_never_guessed_to_be_user_messages() {
    let chunks = vec![chunk(
        0,
        "raw",
        "provider_specific_role",
        json!({"content": "do not relabel"}),
    )];
    let projected = projected_with_manifest(&chunks, empty_manifest());

    assert!(projected.events.is_empty());
    assert_eq!(
        projected.loss_manifest.entries,
        vec![PortableLossEntry {
            reason: PortableLossReason::UnknownRole,
            impact: PortableLossImpact::VisibleBlocking,
            count: 1,
        }]
    );
    assert!(!projected.loss_manifest.is_exact_visible());
    assert!(exact_project(chunks).is_err());
}

#[test]
fn pending_tool_call_has_no_fabricated_result() {
    let mut tool = chunk(
        0,
        "tool_call",
        "read_file",
        json!({
            "call_id": "call-pending",
            "raw_tool_name": "Read",
            "status": "running"
        }),
    );
    tool.args = json!({"path": "README.md"});

    let projected = exact_project(vec![tool]).expect("pending call is exact");
    assert_eq!(projected.events.len(), 1);
    assert!(matches!(
        &projected.events[0].body,
        PortableEventBody::ToolCall {
            call_id,
            state: PortableToolCallState::Pending,
            ..
        } if call_id == "call-pending"
    ));

    let pending_with_output = chunk(
        1,
        "tool_call",
        "read_file",
        json!({
            "call_id": "call-progress",
            "status": "running",
            "output": "partial output"
        }),
    );
    assert!(exact_project(vec![pending_with_output])
        .expect_err("pending output cannot be dropped")
        .contains("contains result payload"));
}

#[test]
fn settled_tool_call_preserves_linkage_input_and_result() {
    let mut tool = settled_tool(0, "call-1", json!({"z": 1, "a": [true, 1.5]}));
    tool.args = json!({"z": 1, "a": {"y": 2, "b": 3}});

    let projected = exact_project(vec![tool]).expect("settled call is exact");
    assert_eq!(projected.events.len(), 2);
    assert!(matches!(
        &projected.events[0].body,
        PortableEventBody::ToolCall {
            call_id,
            name,
            state: PortableToolCallState::Settled,
            input,
            ..
        } if call_id == "call-1"
            && name == "Shell"
            && input == &json!({"a": {"b": 3, "y": 2}, "z": 1})
    ));
    assert!(matches!(
        &projected.events[1].body,
        PortableEventBody::ToolResult { call_id, content, .. }
            if call_id == "call-1"
                && content == &vec![PortableContentBlock::Json {
                    value: json!({"a": [true, 1.5], "z": 1})
                }]
    ));
}

#[test]
fn tool_status_is_required_and_linkage_repairs_are_blocking() {
    let missing_status = chunk(
        0,
        "tool_call",
        "shell",
        json!({"call_id": "call-1", "output": "done"}),
    );
    assert!(exact_project(vec![missing_status])
        .expect_err("status cannot be inferred")
        .contains("explicitly declare"));

    let chunks = vec![
        settled_tool(0, "same", json!("one")),
        settled_tool(1, "same", json!("two")),
    ];
    let projected = projected_with_manifest(&chunks, empty_manifest());
    assert_eq!(
        projected.loss_manifest.fidelity.continuation,
        PortableContinuationFidelity::BlockingLoss
    );
    assert!(projected.loss_manifest.is_exact_visible());
    assert!(!projected.loss_manifest.is_continuation_materializable());
    assert!(exact_project(chunks).is_err());
}

#[test]
fn ambiguous_normalized_content_is_rejected_instead_of_selecting_one_alias() {
    let message = chunk(
        0,
        "raw",
        "user_message",
        json!({"content": "one", "text": "two"}),
    );
    assert!(exact_project(vec![message])
        .expect_err("ambiguous message")
        .contains("multiple content fields"));

    let tool = chunk(
        0,
        "tool_call",
        "shell",
        json!({
            "call_id": "call-1",
            "status": "completed",
            "output": "one",
            "observation": "two"
        }),
    );
    assert!(exact_project(vec![tool])
        .expect_err("ambiguous tool result")
        .contains("multiple content fields"));

    let malformed_images = vec![chunk(
        0,
        "raw",
        "user_message",
        json!({"content": "image", "images": "not-an-array"}),
    )];
    let projected = projected_with_manifest(&malformed_images, empty_manifest());
    assert_eq!(
        projected.loss_manifest.entries[0].reason,
        PortableLossReason::InvalidAttachmentReference
    );
    assert!(exact_project(malformed_images).is_err());
}

#[test]
fn decoder_rejects_duplicate_pending_or_missing_tool_results() {
    let settled =
        exact_project(vec![settled_tool(0, "call-1", json!("done"))]).expect("settled fixture");

    let mut duplicate = settled.clone();
    let mut duplicate_result = duplicate.events[1].clone();
    duplicate_result.event_id.push_str(":duplicate");
    duplicate.events.push(duplicate_result);
    assert!(duplicate
        .validate()
        .expect_err("duplicate result")
        .contains("Duplicate portable tool result"));

    let mut pending_with_result = settled.clone();
    let PortableEventBody::ToolCall { state, .. } = &mut pending_with_result.events[0].body else {
        panic!("tool call");
    };
    *state = PortableToolCallState::Pending;
    assert!(pending_with_result
        .validate()
        .expect_err("pending result")
        .contains("Pending portable tool call"));

    let mut missing = settled;
    missing.events.pop();
    assert!(missing
        .validate()
        .expect_err("missing result")
        .contains("has no result"));
}

#[test]
fn fidelity_separates_visible_exactness_from_continuation_context() {
    let thinking = chunk(0, "thinking", "thinking", json!({"content": "private"}));
    let degraded = exact_project(vec![thinking]).expect("private loss is non-blocking");
    assert!(degraded.loss_manifest.is_exact_visible());
    assert!(degraded.loss_manifest.is_continuation_materializable());
    assert!(!degraded.loss_manifest.is_continuation_complete());
    assert_eq!(
        degraded.loss_manifest.fidelity.continuation,
        PortableContinuationFidelity::ContextDegraded
    );

    let context_loss = manifest(PortableLossReason::SystemContextOmitted, 1);
    assert!(context_loss.is_exact_visible());
    assert!(!context_loss.is_continuation_materializable());
    assert!(project_exact_read(ExactReadOutcome {
        source: source(),
        chunks: Vec::new(),
        reader_loss_manifest: context_loss,
    })
    .is_err());

    let visible_loss = manifest(PortableLossReason::SourceVisibleContentTruncated, 1);
    assert!(!visible_loss.is_exact_visible());
}

#[test]
fn attachment_content_must_be_embedded_for_exact_export() {
    let local_or_remote = vec![chunk(
        0,
        "raw",
        "user_message",
        json!({
            "content": "images",
            "images": ["/tmp/local.png", "https://example.invalid/mutable.png"]
        }),
    )];
    let projected = projected_with_manifest(&local_or_remote, empty_manifest());
    assert_eq!(
        projected.loss_manifest.entries,
        vec![
            PortableLossEntry {
                reason: PortableLossReason::LocalAttachmentUnavailable,
                impact: PortableLossImpact::VisibleBlocking,
                count: 1,
            },
            PortableLossEntry {
                reason: PortableLossReason::RemoteAttachmentUncaptured,
                impact: PortableLossImpact::VisibleBlocking,
                count: 1,
            },
        ]
    );
    assert!(exact_project(local_or_remote).is_err());

    let embedded = exact_project(vec![chunk(
        0,
        "raw",
        "user_message",
        json!({
            "content": "image",
            "images": ["data:image/png;base64,c21hbGw="]
        }),
    )])
    .expect("embedded image");
    assert!(embedded.loss_manifest.is_exact_visible());
}

#[test]
fn exact_reader_loss_manifest_is_validated_before_projection() {
    let mut malformed = manifest(PortableLossReason::PrivateReasoningOmitted, 1);
    malformed.entries[0].impact = PortableLossImpact::Informational;
    let error = project_exact_read(ExactReadOutcome {
        source: source(),
        chunks: Vec::new(),
        reader_loss_manifest: malformed,
    })
    .expect_err("invalid reader manifest");
    assert!(error.contains("impact does not match"));
}

#[test]
fn source_snapshot_digest_and_source_order_are_fail_closed() {
    let mut projected = exact_project(vec![
        chunk(0, "raw", "user_message", json!({"content": "one"})),
        chunk(1, "assistant", "assistant", json!({"content": "two"})),
    ])
    .expect("fixture");
    projected.source.source_snapshot.digest = "ABC".to_string();
    assert!(projected.validate().is_err());

    projected.source.source_snapshot.digest =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string();
    projected.events[0].source_index = 2;
    assert!(projected.validate().is_err());
}

#[test]
fn source_identity_ephemeral_deltas_and_thread_context_are_explicit() {
    let mut wrong_session = chunk(0, "raw", "user_message", json!({"content": "wrong root"}));
    wrong_session.session_id = "another-session".to_string();
    assert!(exact_project(vec![wrong_session])
        .expect_err("mixed source sessions")
        .contains("different session"));

    let mut ephemeral = chunk(0, "assistant", "assistant", json!({"content": "delta"}));
    ephemeral.broadcast_only = true;
    assert!(exact_project(vec![ephemeral])
        .expect_err("ephemeral delta")
        .contains("ephemeral broadcast delta"));

    let mut threaded = chunk(0, "raw", "user_message", json!({"content": "branch"}));
    threaded.thread_id = Some("thread-a".to_string());
    threaded.process_id = Some("local-pid".to_string());
    let projected = exact_project(vec![threaded]).expect("runtime loss is non-blocking");
    assert_eq!(
        projected.events[0].source_thread_id.as_deref(),
        Some("thread-a")
    );
    assert_eq!(
        projected.loss_manifest.entries,
        vec![PortableLossEntry {
            reason: PortableLossReason::OpaqueProviderStateOmitted,
            impact: PortableLossImpact::ContinuationDegrading,
            count: 1,
        }]
    );
}

#[test]
fn embedded_image_validation_rejects_malformed_base64_padding() {
    for uri in [
        "data:image/png;base64,ab=c",
        "data:image/png;base64,a===",
        "data:image/svg+xml;base64,PHN2Zz4=",
    ] {
        assert!(!portable_image_uri(uri), "accepted malformed URI: {uri}");
    }
    assert!(portable_image_uri("data:image/png;base64,c21hbGw="));
}

#[test]
fn canonical_v1_bytes_and_digest_are_frozen() {
    let mut pending = chunk(
        2,
        "tool_call",
        "read_file",
        json!({
            "call_id": "pending-1",
            "raw_tool_name": "Read",
            "status": "pending"
        }),
    );
    pending.args = json!({"z": 1.5, "a": ["\u{1}", true]});
    let projected = exact_project(vec![
        chunk(
            0,
            "raw",
            "system_message",
            json!({"content": "规则\n\"严\""}),
        ),
        chunk(1, "raw", "user_message", json!({"content": "你好"})),
        pending,
        chunk(3, "task_completed", "", json!({})),
    ])
    .expect("golden projection");
    let encoded = projected.encode_canonical().expect("canonical encode");

    assert_eq!(
        String::from_utf8(encoded.bytes.clone()).expect("UTF-8 JSON"),
        include_str!("../testdata/portable-conversation-v1.json").trim_end_matches('\n')
    );
    assert_eq!(
        encoded.sha256,
        include_str!("../testdata/portable-conversation-v1.sha256").trim()
    );
    assert_eq!(
        PortableConversation::decode_canonical(&encoded.bytes).expect("canonical decode"),
        projected
    );
}

#[test]
fn canonical_decoder_rejects_pretty_or_reordered_json() {
    let projected = exact_project(vec![chunk(
        0,
        "assistant",
        "assistant",
        json!({"content": "done"}),
    )])
    .expect("fixture");
    let pretty = serde_json::to_vec_pretty(&projected).expect("pretty");
    assert!(PortableConversation::decode_canonical(&pretty).is_err());

    let reordered = serde_json::to_vec(&projected).expect("serde order differs from canonical");
    assert!(PortableConversation::decode_canonical(&reordered).is_err());
}

#[test]
fn canonical_size_limit_is_checked_before_value_materialization() {
    let text = "x".repeat(2_048);
    let projected = exact_project(vec![chunk(
        0,
        "raw",
        "user_message",
        json!({"content": text}),
    )])
    .expect("fixture");
    let error = crate::canonical::encode_canonical_json_with_test_limit(&projected, 1_024)
        .expect_err("small test limit");
    assert!(error.contains("payload is at least"));
}

#[test]
fn nested_tool_json_is_bounded_before_projection_clones_it() {
    let mut input = Value::Null;
    for _ in 0..=MAX_PORTABLE_JSON_DEPTH {
        input = Value::Array(vec![input]);
    }
    let mut tool = chunk(
        0,
        "tool_call",
        "deep_tool",
        json!({"call_id": "deep", "status": "pending"}),
    );
    tool.args = input;

    assert!(exact_project(vec![tool])
        .expect_err("deep JSON")
        .contains("nesting limit"));
}

#[test]
fn decoder_rejects_overflowing_loss_totals() {
    let mut projected = exact_project(vec![chunk(
        0,
        "raw",
        "user_message",
        json!({"content": "one"}),
    )])
    .expect("fixture");
    projected.loss_manifest = PortableLossManifest {
        fidelity: PortableFidelity::default(),
        entries: vec![
            PortableLossEntry {
                reason: PortableLossReason::EmptyVisibleMessage,
                impact: PortableLossImpact::VisibleBlocking,
                count: u64::MAX,
            },
            PortableLossEntry {
                reason: PortableLossReason::UnsupportedChunk,
                impact: PortableLossImpact::VisibleBlocking,
                count: 1,
            },
        ],
        total_omitted_items: 0,
    };
    assert!(projected
        .validate()
        .expect_err("loss counts must not wrap")
        .contains("overflowed"));
}
