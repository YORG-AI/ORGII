use serde_json::{json, Value};

use crate::*;

const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn source() -> PortableConversationSource {
    PortableConversationSource {
        source_kind: "fixture".to_string(),
        source_session_id: "fixture-session".to_string(),
        source_snapshot: PortableSourceSnapshot {
            algorithm: PortableSourceSnapshotAlgorithm::Sha256,
            digest: DIGEST.to_string(),
            observed_bytes: 42,
        },
        parser_version: 2,
        source_runtime_version: Some("1.2.3".to_string()),
        title: Some("A session".to_string()),
        model: Some("model".to_string()),
        source_workspace_hint: Some("/source/only".to_string()),
        started_at: Some("2026-08-25T00:00:00Z".to_string()),
        updated_at: Some("2026-08-25T00:01:00Z".to_string()),
    }
}

fn event(
    logical_index: u64,
    record_index: u64,
    block_index: Option<u64>,
    suffix: &str,
    body: PortableEventBody,
) -> PortableEvent {
    PortableEvent {
        event_id: format!("record-{record_index}:{suffix}"),
        source_index: logical_index,
        source_record_index: record_index,
        source_record_type: Some("fixture_record".to_string()),
        source_record_id: Some(format!("native-{record_index}")),
        source_block_index: block_index,
        source_thread_id: Some("main".to_string()),
        timestamp: Some(format!("2026-08-25T00:00:{record_index:02}Z")),
        body,
    }
}

fn message(
    logical_index: u64,
    record_index: u64,
    block_index: Option<u64>,
    role: PortableRole,
    content: PortableContentBlock,
) -> PortableEvent {
    event(
        logical_index,
        record_index,
        block_index,
        &format!("block-{}", block_index.unwrap_or_default()),
        PortableEventBody::Message {
            role,
            content: vec![content],
        },
    )
}

fn exact(events: Vec<PortableEvent>) -> PortableConversation {
    ExactReadOutcome {
        source: source(),
        events,
        reader_loss_manifest: PortableLossManifest::default(),
    }
    .finalize()
    .expect("valid exact fixture")
}

fn mixed_fixture() -> PortableConversation {
    exact(vec![
        message(
            0,
            3,
            Some(0),
            PortableRole::User,
            PortableContentBlock::Text {
                text: "开头原文".repeat(4),
            },
        ),
        message(
            1,
            3,
            Some(1),
            PortableRole::User,
            PortableContentBlock::Image {
                uri: "data:image/png;base64,c21hbGw=".to_string(),
            },
        ),
        message(
            2,
            3,
            Some(2),
            PortableRole::User,
            PortableContentBlock::Text {
                text: "结尾原文".to_string(),
            },
        ),
        event(
            3,
            3,
            Some(3),
            "tool",
            PortableEventBody::ToolCall {
                call_id: "call-1".to_string(),
                name: "Read".to_string(),
                canonical_name: "read_file".to_string(),
                state: PortableToolCallState::Settled,
                input: json!({"path": "原文.md"}),
            },
        ),
        event(
            4,
            8,
            Some(0),
            "tool-result",
            PortableEventBody::ToolResult {
                call_id: "call-1".to_string(),
                content: vec![PortableContentBlock::Text {
                    text: "完整结果".to_string(),
                }],
                is_error: false,
            },
        ),
    ])
}

#[test]
fn preserves_interleaved_blocks_multi_text_and_native_grouping() {
    let conversation = mixed_fixture();
    assert_eq!(conversation.events.len(), 5);
    assert_eq!(
        conversation.events[..4]
            .iter()
            .map(|event| event.source_record_index)
            .collect::<Vec<_>>(),
        vec![3, 3, 3, 3]
    );
    assert_eq!(
        conversation.events[..4]
            .iter()
            .map(|event| event.source_block_index)
            .collect::<Vec<_>>(),
        vec![Some(0), Some(1), Some(2), Some(3)]
    );
    assert!(matches!(
        &conversation.events[0].body,
        PortableEventBody::Message { content, .. }
            if matches!(&content[0], PortableContentBlock::Text { text } if text.starts_with("开头原文"))
    ));
    assert!(matches!(
        &conversation.events[1].body,
        PortableEventBody::Message { content, .. }
            if matches!(&content[0], PortableContentBlock::Image { .. })
    ));
    assert!(matches!(
        &conversation.events[2].body,
        PortableEventBody::Message { content, .. }
            if matches!(&content[0], PortableContentBlock::Text { text } if text == "结尾原文")
    ));
}

#[test]
fn compaction_boundary_and_summary_are_independent_ordered_semantics() {
    let boundary_only = exact(vec![event(
        0,
        4,
        None,
        "boundary",
        PortableEventBody::CompactionBoundary {
            content: vec![PortableContentBlock::Text {
                text: "portable boundary context".to_string(),
            }],
        },
    )]);
    assert!(matches!(
        boundary_only.events[0].body,
        PortableEventBody::CompactionBoundary { .. }
    ));
    let boundary_canonical = boundary_only
        .encode_canonical()
        .expect("encode boundary golden");
    assert_eq!(
        boundary_canonical.bytes,
        include_bytes!("../testdata/portable-compaction-boundary-v2.canonical")
            .strip_suffix(b"\n")
            .expect("boundary golden newline")
    );
    assert_eq!(
        boundary_canonical.sha256,
        include_str!("../testdata/portable-compaction-boundary-v2.sha256").trim()
    );

    let empty_boundary = exact(vec![event(
        0,
        5,
        None,
        "empty-boundary",
        PortableEventBody::CompactionBoundary {
            content: Vec::new(),
        },
    )]);
    let canonical = empty_boundary.encode_canonical().expect("encode boundary");
    let decoded = PortableConversation::decode_canonical(&canonical.bytes)
        .expect("empty boundary canonical round trip");
    assert!(matches!(
        decoded.events[0].body,
        PortableEventBody::CompactionBoundary { ref content } if content.is_empty()
    ));

    let summary_only = exact(vec![event(
        0,
        7,
        None,
        "summary",
        PortableEventBody::CompactionSummary {
            content: vec![PortableContentBlock::Text {
                text: "summary".to_string(),
            }],
        },
    )]);
    assert!(matches!(
        summary_only.events[0].body,
        PortableEventBody::CompactionSummary { .. }
    ));
}

#[test]
fn source_record_groups_are_contiguous_consistent_and_strictly_ordered() {
    let mut repeated = mixed_fixture();
    repeated.events[4].source_record_index = 3;
    assert!(repeated
        .validate()
        .expect_err("inconsistent reused group")
        .contains("inconsistent provenance"));

    let mut non_contiguous = mixed_fixture();
    let tail = message(
        5,
        3,
        Some(4),
        PortableRole::User,
        PortableContentBlock::Text {
            text: "late".to_string(),
        },
    );
    non_contiguous.events.push(tail);
    assert!(non_contiguous
        .validate()
        .expect_err("record group cannot resume")
        .contains("contiguous"));

    let mut duplicate_block = mixed_fixture();
    duplicate_block.events[2].source_block_index = Some(1);
    assert!(duplicate_block
        .validate()
        .expect_err("block indices are strict")
        .contains("strict source-record order"));

    let mut missing_block = mixed_fixture();
    missing_block.events[1].source_block_index = None;
    assert!(missing_block
        .validate()
        .expect_err("group blocks need ordinals")
        .contains("requires every event"));
}

#[test]
fn tool_linkage_and_logical_indices_fail_closed() {
    let settled = mixed_fixture();

    let mut duplicate = settled.clone();
    let mut result = duplicate.events[4].clone();
    result.event_id.push_str(":duplicate");
    result.source_index = 5;
    result.source_record_index = 9;
    result.source_record_id = Some("native-9".to_string());
    duplicate.events.push(result);
    assert!(duplicate
        .validate()
        .expect_err("duplicate result")
        .contains("Duplicate portable tool result"));

    let mut pending = settled.clone();
    let PortableEventBody::ToolCall { state, .. } = &mut pending.events[3].body else {
        panic!("tool call")
    };
    *state = PortableToolCallState::Pending;
    assert!(pending
        .validate()
        .expect_err("pending cannot have result")
        .contains("Pending portable tool call"));

    let mut duplicate_index = settled;
    duplicate_index.events[1].source_index = 0;
    assert!(duplicate_index
        .validate()
        .expect_err("logical indices are strict")
        .contains("contiguous from zero"));
}

#[test]
fn loss_manifest_separates_degraded_from_blocking_context() {
    let degraded = PortableLossManifest::from_reason_counts([(
        PortableLossReason::OpaqueProviderStateOmitted,
        2,
    )])
    .expect("degraded manifest");
    assert!(degraded.is_exact_visible());
    assert!(degraded.is_continuation_materializable());
    assert!(!degraded.is_continuation_complete());

    let blocked =
        PortableLossManifest::from_reason_counts([(PortableLossReason::SystemContextOmitted, 1)])
            .expect("blocking manifest");
    let error = ExactReadOutcome {
        source: source(),
        events: vec![message(
            0,
            0,
            None,
            PortableRole::User,
            PortableContentBlock::Text {
                text: "message".to_string(),
            },
        )],
        reader_loss_manifest: blocked,
    }
    .finalize()
    .expect_err("blocking loss cannot finalize");
    assert_eq!(error.kind, ExactReadFailureKind::BlockingLoss);
}

#[test]
fn canonical_v2_golden_freezes_grouping_and_boundary_fields() {
    let conversation = mixed_fixture();
    let encoded = conversation.encode_canonical().expect("canonical fixture");
    let golden = include_bytes!("../testdata/portable-conversation-v2.canonical")
        .strip_suffix(b"\n")
        .expect("golden newline");
    assert_eq!(encoded.bytes, golden);
    assert_eq!(
        encoded.sha256,
        include_str!("../testdata/portable-conversation-v2.sha256").trim()
    );
    assert_eq!(
        PortableConversation::decode_canonical(golden),
        Ok(conversation)
    );
}

#[test]
fn decoder_rejects_unknown_fields_variants_and_old_schema() {
    let encoded = mixed_fixture()
        .encode_canonical()
        .expect("canonical fixture");
    let value: Value = serde_json::from_slice(&encoded.bytes).expect("JSON");

    for pointer in [
        "",
        "/source",
        "/source/sourceSnapshot",
        "/events/0",
        "/events/0/content/0",
        "/lossManifest",
        "/lossManifest/fidelity",
    ] {
        let mut candidate = value.clone();
        candidate
            .pointer_mut(pointer)
            .and_then(Value::as_object_mut)
            .expect("object pointer")
            .insert("unknownField".to_string(), Value::Bool(true));
        let bytes = serde_json::to_vec(&candidate).expect("candidate");
        assert!(PortableConversation::decode_canonical(&bytes)
            .expect_err("unknown fields must fail")
            .contains("unknown"));
    }

    let mut unknown_loss_entry = value.clone();
    unknown_loss_entry["lossManifest"] = json!({
        "fidelity": {"visible": "exact", "continuation": "context_degraded"},
        "entries": [{
            "reason": "runtime_lifecycle_omitted",
            "impact": "continuation_degrading",
            "count": 1,
            "unknownField": true
        }],
        "totalOmittedItems": 1
    });
    assert!(PortableConversation::decode_canonical(
        &serde_json::to_vec(&unknown_loss_entry).expect("candidate")
    )
    .expect_err("unknown loss-entry field must fail")
    .contains("unknown"));

    let mut unknown_kind = value.clone();
    unknown_kind["events"][0]["kind"] = Value::String("future_visible_record".to_string());
    assert!(PortableConversation::decode_canonical(
        &serde_json::to_vec(&unknown_kind).expect("candidate")
    )
    .is_err());

    let mut old_version = value;
    old_version["schemaVersion"] = Value::from(1);
    assert!(PortableConversation::decode_canonical(
        &serde_json::to_vec(&old_version).expect("candidate")
    )
    .expect_err("v1 is not v2")
    .contains("version"));
}

#[test]
fn bounds_reject_event_count_payload_size_and_json_depth() {
    let conversation = mixed_fixture();
    assert!(
        crate::canonical::encode_canonical_json_with_test_limit(&conversation, 32)
            .expect_err("small output cap")
            .contains("limit")
    );

    let mut too_many = conversation.clone();
    too_many.events = (0..=MAX_PORTABLE_CONVERSATION_EVENTS)
        .map(|index| {
            message(
                index as u64,
                index as u64,
                None,
                PortableRole::User,
                PortableContentBlock::Text {
                    text: "x".to_string(),
                },
            )
        })
        .collect();
    assert!(too_many
        .validate()
        .expect_err("event cap")
        .contains("limit"));

    let mut nested = Value::Null;
    for _ in 0..=MAX_PORTABLE_JSON_DEPTH {
        nested = Value::Array(vec![nested]);
    }
    let mut deep = conversation;
    deep.events[3].body = PortableEventBody::ToolCall {
        call_id: "call-1".to_string(),
        name: "Read".to_string(),
        canonical_name: "read_file".to_string(),
        state: PortableToolCallState::Settled,
        input: nested,
    };
    assert!(deep.validate().expect_err("depth cap").contains("nesting"));

    let mut wide = mixed_fixture();
    wide.events[3].body = PortableEventBody::ToolCall {
        call_id: "call-1".to_string(),
        name: "Read".to_string(),
        canonical_name: "read_file".to_string(),
        state: PortableToolCallState::Settled,
        input: Value::Array(vec![Value::Null; MAX_PORTABLE_JSON_NODES]),
    };
    assert!(wide
        .validate()
        .expect_err("node cap")
        .contains("node limit"));

    assert!(PortableLossManifest::from_reason_counts([
        (PortableLossReason::RuntimeLifecycleOmitted, u64::MAX),
        (PortableLossReason::PrivateReasoningOmitted, 1),
    ])
    .expect_err("loss total overflow")
    .contains("overflow"));
}
