use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use conversation_portability::{
    ExactConversationReader, ExactReadFailureKind, PortableContentBlock, PortableEventBody,
    PortableRole, PortableToolCallState,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::source_file::{
    production_limits_for_test, read_source_records_with_limits,
    read_source_records_with_open_hook, ExactReadLimits,
};
use super::*;

const CLAUDE_SESSION: &str = "11111111-1111-4111-8111-111111111111";
const CLAUDE_USER: &str = "22222222-2222-4222-8222-222222222222";
const CLAUDE_ASSISTANT: &str = "33333333-3333-4333-8333-333333333333";
const CLAUDE_RESULT: &str = "44444444-4444-4444-8444-444444444444";
const CLAUDE_LEAF: &str = "55555555-5555-4555-8555-555555555555";
const CLAUDE_BOUNDARY: &str = "66666666-6666-4666-8666-666666666666";
const CLAUDE_SUMMARY: &str = "77777777-7777-4777-8777-777777777777";
const CODEX_THREAD: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

struct TempTree(PathBuf);

impl TempTree {
    fn new(label: &str) -> Self {
        let suffix = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "org2-exact-{label}-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create fixture root");
        Self(root)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_jsonl(path: &Path, records: &[Value]) {
    let mut bytes = records
        .iter()
        .map(|record| serde_json::to_string(record).expect("serialize fixture"))
        .collect::<Vec<_>>()
        .join("\n")
        .into_bytes();
    bytes.push(b'\n');
    fs::write(path, bytes).expect("write fixture");
}

fn claude_record(
    record_type: &str,
    uuid: &str,
    parent_uuid: Option<&str>,
    message: Value,
) -> Value {
    json!({
        "type": record_type,
        "uuid": uuid,
        "parentUuid": parent_uuid,
        "sessionId": CLAUDE_SESSION,
        "cwd": "/workspace/原项目",
        "version": "2.1.209",
        "timestamp": "2026-08-26T00:00:00Z",
        "message": message,
    })
}

fn claude_mixed_records(long_tail: &str) -> Vec<Value> {
    vec![
        claude_record(
            "user",
            CLAUDE_USER,
            None,
            json!({"role": "user", "content": "开始"}),
        ),
        claude_record(
            "assistant",
            CLAUDE_ASSISTANT,
            Some(CLAUDE_USER),
            json!({
                "role": "assistant",
                "model": "claude-sonnet-4-20250514",
                "content": [
                    {"type": "text", "text": "第一段"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "c21hbGw="}},
                    {"type": "text", "text": "第二段"},
                    {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {"file_path": "原文.md"}},
                ]
            }),
        ),
        claude_record(
            "user",
            CLAUDE_RESULT,
            Some(CLAUDE_ASSISTANT),
            json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "tool-1",
                    "is_error": true,
                    "content": [
                        {"type": "text", "text": "工具原文"},
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "c21hbGw="}}
                    ]
                }]
            }),
        ),
        claude_record(
            "assistant",
            CLAUDE_LEAF,
            Some(CLAUDE_RESULT),
            json!({
                "role": "assistant",
                "model": "claude-sonnet-4-20250514",
                "content": [{"type": "text", "text": long_tail}]
            }),
        ),
        json!({"type": "last-prompt", "sessionId": CLAUDE_SESSION, "leafUuid": CLAUDE_LEAF}),
    ]
}

fn claude_source(root: &Path) -> ExactImportedFileSource {
    ExactImportedFileSource {
        kind: ExactImportedSourceKind::ClaudeCode,
        source_session_id: CLAUDE_SESSION.to_string(),
        source_path: root.join(format!("{CLAUDE_SESSION}.jsonl")),
        containment_root: root.to_path_buf(),
        title: None,
        model: None,
        source_workspace_hint: Some("/workspace/原项目".to_string()),
    }
}

fn codex_source(root: &Path) -> ExactImportedFileSource {
    ExactImportedFileSource {
        kind: ExactImportedSourceKind::Codex,
        source_session_id: CODEX_THREAD.to_string(),
        source_path: root.join(format!("rollout-2026-08-26T00-00-00-{CODEX_THREAD}.jsonl")),
        containment_root: root.to_path_buf(),
        title: None,
        model: None,
        source_workspace_hint: Some("/workspace/codex".to_string()),
    }
}

fn codex_meta() -> Value {
    json!({
        "timestamp": "2026-08-26T00:00:00Z",
        "type": "session_meta",
        "payload": {
            "id": CODEX_THREAD,
            "history_mode": "legacy",
            "cwd": "/workspace/codex",
            "cli_version": "0.144.4"
        }
    })
}

fn codex_message(role: &str, content: Value) -> Value {
    json!({
        "timestamp": "2026-08-26T00:00:01Z",
        "type": "response_item",
        "payload": {"type": "message", "role": role, "content": content}
    })
}

#[test]
fn claude_preserves_interleaved_blocks_tools_images_and_long_chinese() {
    let temp = TempTree::new("claude-mixed");
    let source = claude_source(temp.path());
    let long_tail = "中文原文🙂".repeat(8_192);
    write_jsonl(&source.source_path, &claude_mixed_records(&long_tail));

    let conversation = read_exact_imported_file(source).expect("exact Claude transcript");
    assert_eq!(conversation.source.source_session_id, CLAUDE_SESSION);
    assert_eq!(
        conversation.source.source_runtime_version.as_deref(),
        Some("2.1.209")
    );
    assert_eq!(conversation.events.len(), 7);
    assert_eq!(
        conversation.events[1..5]
            .iter()
            .map(|event| (event.source_record_index, event.source_block_index))
            .collect::<Vec<_>>(),
        vec![(1, Some(0)), (1, Some(1)), (1, Some(2)), (1, Some(3))]
    );
    assert!(matches!(
        &conversation.events[1].body,
        PortableEventBody::Message { content, .. }
            if content == &vec![PortableContentBlock::Text { text: "第一段".to_string() }]
    ));
    assert!(matches!(
        &conversation.events[2].body,
        PortableEventBody::Message { content, .. }
            if matches!(&content[0], PortableContentBlock::Image { .. })
    ));
    assert!(matches!(
        &conversation.events[3].body,
        PortableEventBody::Message { content, .. }
            if content == &vec![PortableContentBlock::Text { text: "第二段".to_string() }]
    ));
    assert!(matches!(
        &conversation.events[4].body,
        PortableEventBody::ToolCall { call_id, state: PortableToolCallState::Settled, .. }
            if call_id == "tool-1"
    ));
    assert!(matches!(
        &conversation.events[5].body,
        PortableEventBody::ToolResult { call_id, is_error: true, content }
            if call_id == "tool-1" && content.len() == 2
    ));
    assert!(matches!(
        &conversation.events[6].body,
        PortableEventBody::Message { content, .. }
            if matches!(&content[0], PortableContentBlock::Text { text } if text == &long_tail)
    ));
}

#[test]
fn claude_active_graph_uses_last_prompt_and_ignores_known_abandoned_branch() {
    let temp = TempTree::new("claude-branch");
    let source = claude_source(temp.path());
    let abandoned = "88888888-8888-4888-8888-888888888888";
    let mut records = claude_mixed_records("active");
    records.insert(
        4,
        claude_record(
            "assistant",
            abandoned,
            Some(CLAUDE_USER),
            json!({"role": "assistant", "content": "abandoned"}),
        ),
    );
    write_jsonl(&source.source_path, &records);

    let conversation = read_exact_imported_file(source).expect("active branch");
    assert!(!conversation.events.iter().any(|event| matches!(
        &event.body,
        PortableEventBody::Message { content, .. }
            if content.iter().any(|block| matches!(block, PortableContentBlock::Text { text } if text == "abandoned"))
    )));
}

#[test]
fn claude_compaction_boundary_and_summary_remain_two_events() {
    let temp = TempTree::new("claude-compact");
    let source = claude_source(temp.path());
    let records = vec![
        claude_record(
            "user",
            CLAUDE_USER,
            None,
            json!({"role": "user", "content": "before"}),
        ),
        claude_record(
            "assistant",
            CLAUDE_ASSISTANT,
            Some(CLAUDE_USER),
            json!({"role": "assistant", "model": "claude", "content": "answer"}),
        ),
        json!({
            "type": "system",
            "subtype": "compact_boundary",
            "uuid": CLAUDE_BOUNDARY,
            "parentUuid": null,
            "logicalParentUuid": CLAUDE_ASSISTANT,
            "sessionId": CLAUDE_SESSION,
            "cwd": "/workspace/原项目",
            "version": "2.1.209",
            "timestamp": "2026-08-26T00:00:02Z",
            "content": "boundary context"
        }),
        {
            let mut summary = claude_record(
                "user",
                CLAUDE_SUMMARY,
                Some(CLAUDE_BOUNDARY),
                json!({"role": "user", "content": [{"type": "text", "text": "compact summary"}]}),
            );
            summary["isCompactSummary"] = Value::Bool(true);
            summary
        },
        json!({"type": "last-prompt", "sessionId": CLAUDE_SESSION, "leafUuid": CLAUDE_SUMMARY}),
    ];
    write_jsonl(&source.source_path, &records);

    let conversation = read_exact_imported_file(source).expect("compacted Claude transcript");
    assert!(matches!(
        conversation.events[2].body,
        PortableEventBody::CompactionBoundary { .. }
    ));
    assert!(matches!(
        conversation.events[3].body,
        PortableEventBody::CompactionSummary { .. }
    ));
}

#[test]
fn claude_verified_preserved_compaction_back_edge_selects_post_compaction_graph() {
    let temp = TempTree::new("claude-preserved-back-edge");
    let source = claude_source(temp.path());
    let after_one = "88888888-8888-4888-8888-888888888888";
    let after_two = "99999999-9999-4999-8999-999999999999";
    let records = vec![
        json!({
            "type": "system",
            "subtype": "compact_boundary",
            "uuid": CLAUDE_BOUNDARY,
            "parentUuid": null,
            "logicalParentUuid": after_two,
            "sessionId": CLAUDE_SESSION,
            "cwd": "/workspace/原项目",
            "version": "2.1.209",
            "timestamp": "2026-08-26T00:00:00Z",
            "compactMetadata": {
                "preservedSegment": {
                    "anchorUuid": CLAUDE_SUMMARY,
                    "headUuid": after_one,
                    "tailUuid": after_two
                },
                "preservedMessages": {"allUuids": [after_one, after_two]}
            }
        }),
        {
            let mut summary = claude_record(
                "user",
                CLAUDE_SUMMARY,
                Some(CLAUDE_BOUNDARY),
                json!({"role": "user", "content": "summary"}),
            );
            summary["isCompactSummary"] = Value::Bool(true);
            summary
        },
        claude_record(
            "assistant",
            after_one,
            Some(CLAUDE_SUMMARY),
            json!({"role": "assistant", "content": "after one"}),
        ),
        claude_record(
            "user",
            after_two,
            Some(after_one),
            json!({"role": "user", "content": "after two"}),
        ),
        claude_record(
            "assistant",
            CLAUDE_LEAF,
            Some(after_two),
            json!({"role": "assistant", "content": "complete"}),
        ),
        json!({"type": "last-prompt", "sessionId": CLAUDE_SESSION, "leafUuid": CLAUDE_LEAF}),
    ];
    write_jsonl(&source.source_path, &records);

    let conversation = read_exact_imported_file(source).expect("verified preserved loop");
    assert!(matches!(
        conversation.events[0].body,
        PortableEventBody::CompactionBoundary { .. }
    ));
    assert!(matches!(
        conversation.events[1].body,
        PortableEventBody::CompactionSummary { .. }
    ));
    assert_eq!(conversation.events.len(), 5);
}

#[test]
fn claude_graph_cycle_missing_parent_meta_and_sidechain_fail_closed() {
    let cases = [
        (
            "missing",
            "99999999-9999-4999-8999-999999999999",
            None,
            false,
            false,
        ),
        ("cycle", CLAUDE_USER, Some(CLAUDE_LEAF), false, false),
        ("meta", CLAUDE_USER, None, true, false),
        ("sidechain", CLAUDE_USER, None, false, true),
    ];
    for (label, parent, root_parent, is_meta, sidechain) in cases {
        let temp = TempTree::new(label);
        let source = claude_source(temp.path());
        let mut leaf = claude_record(
            "assistant",
            CLAUDE_LEAF,
            Some(parent),
            json!({"role": "assistant", "content": "leaf"}),
        );
        leaf["isMeta"] = Value::Bool(is_meta);
        leaf["isSidechain"] = Value::Bool(sidechain);
        write_jsonl(
            &source.source_path,
            &[
                claude_record(
                    "user",
                    CLAUDE_USER,
                    root_parent,
                    json!({"role": "user", "content": "root"}),
                ),
                leaf,
                json!({"type": "last-prompt", "sessionId": CLAUDE_SESSION, "leafUuid": CLAUDE_LEAF}),
            ],
        );
        let error = read_exact_imported_file(source).expect_err("invalid active graph");
        assert!(matches!(
            error.kind,
            ExactReadFailureKind::InvalidConversationGraph
                | ExactReadFailureKind::UnknownRecord
                | ExactReadFailureKind::UnsupportedSource
        ));
    }
}

#[test]
fn claude_rejects_unpaired_summary_and_mixed_identity_workspace_or_version() {
    let temp = TempTree::new("claude-identity-reject");
    let source = claude_source(temp.path());
    let mutations = ["unpaired", "session", "cwd", "version"];
    for mutation in mutations {
        let mut records = claude_mixed_records("tail");
        match mutation {
            "unpaired" => {
                records[3]["isCompactSummary"] = Value::Bool(true);
            }
            "session" => {
                records[3]["sessionId"] =
                    Value::String("aaaaaaaa-1111-4111-8111-111111111111".to_string());
            }
            "cwd" => records[3]["cwd"] = Value::String("/different".to_string()),
            "version" => records[3]["version"] = Value::String("2.1.210".to_string()),
            _ => unreachable!(),
        }
        write_jsonl(&source.source_path, &records);
        assert!(matches!(
            read_exact_imported_file(source.clone())
                .expect_err(mutation)
                .kind,
            ExactReadFailureKind::InvalidConversationGraph
                | ExactReadFailureKind::InvalidSourceIdentity
        ));
    }

    let mut unsupported = claude_mixed_records("tail");
    for record in unsupported.iter_mut().take(4) {
        record["version"] = Value::String("2.1.210".to_string());
    }
    write_jsonl(&source.source_path, &unsupported);
    assert_eq!(
        read_exact_imported_file(source)
            .expect_err("unverified version")
            .kind,
        ExactReadFailureKind::UnsupportedSource
    );
}

#[test]
fn claude_unknown_record_block_role_and_tool_linkage_fail_closed() {
    let temp = TempTree::new("claude-reject");
    let source = claude_source(temp.path());

    write_jsonl(&source.source_path, &[json!({"type": "future-visible"})]);
    assert_eq!(
        read_exact_imported_file(source.clone())
            .expect_err("unknown record")
            .kind,
        ExactReadFailureKind::UnknownRecord
    );

    let mut records = claude_mixed_records("tail");
    records[1]["message"]["content"][0]["type"] = Value::String("future_block".to_string());
    write_jsonl(&source.source_path, &records);
    assert_eq!(
        read_exact_imported_file(source.clone())
            .expect_err("unknown block")
            .kind,
        ExactReadFailureKind::UnknownContentBlock
    );

    let mut records = claude_mixed_records("tail");
    records[1]["message"]["content"][3]
        .as_object_mut()
        .expect("tool_use block")
        .remove("input");
    write_jsonl(&source.source_path, &records);
    assert_eq!(
        read_exact_imported_file(source.clone())
            .expect_err("missing tool input")
            .kind,
        ExactReadFailureKind::UnknownContentBlock
    );

    let mut records = claude_mixed_records("tail");
    records[0]["message"]["role"] = Value::String("developer".to_string());
    write_jsonl(&source.source_path, &records);
    assert_eq!(
        read_exact_imported_file(source.clone())
            .expect_err("unknown role")
            .kind,
        ExactReadFailureKind::UnknownRole
    );

    let mut records = claude_mixed_records("tail");
    records[2]["message"]["content"][0]["tool_use_id"] = Value::String("orphan".to_string());
    write_jsonl(&source.source_path, &records);
    assert_eq!(
        read_exact_imported_file(source)
            .expect_err("orphan result")
            .kind,
        ExactReadFailureKind::InvalidToolLinkage
    );
}

#[test]
fn codex_preserves_canonical_roles_blocks_tools_and_compaction() {
    let temp = TempTree::new("codex-mixed");
    let source = codex_source(temp.path());
    let records = vec![
        codex_meta(),
        codex_message("system", json!([{"type": "input_text", "text": "system"}])),
        codex_message(
            "developer",
            json!([{"type": "input_text", "text": "developer"}]),
        ),
        codex_message(
            "user",
            json!([
                {"type": "input_text", "text": "第一段"},
                {"type": "input_image", "image_url": "data:image/png;base64,c21hbGw="},
                {"type": "input_text", "text": "第二段"}
            ]),
        ),
        codex_message(
            "assistant",
            json!([{"type": "output_text", "text": "answer"}]),
        ),
        json!({"type": "event_msg", "payload": {"type": "agent_message", "message": "answer"}}),
        json!({"type": "response_item", "payload": {"type": "function_call", "call_id": "call-1", "name": "shell", "arguments": "{\"cmd\":\"pwd\"}"}}),
        json!({"type": "response_item", "payload": {"type": "function_call_output", "call_id": "call-1", "output": "done", "is_error": false}}),
        json!({"type": "compacted", "payload": {"message": "summary"}}),
        json!({"type": "event_msg", "payload": {"type": "context_compacted"}}),
        json!({"type": "turn_context", "payload": {"cwd": "/workspace/codex", "model": "gpt-5.6"}}),
    ];
    write_jsonl(&source.source_path, &records);

    let conversation = read_exact_imported_file(source).expect("exact Codex transcript");
    assert_eq!(
        conversation.source.source_runtime_version.as_deref(),
        Some("0.144.4")
    );
    assert!(conversation.events.iter().any(|event| matches!(
        event.body,
        PortableEventBody::Message {
            role: PortableRole::System,
            ..
        }
    )));
    assert!(conversation.events.iter().any(|event| matches!(
        event.body,
        PortableEventBody::Message {
            role: PortableRole::Developer,
            ..
        }
    )));
    let user_group = conversation
        .events
        .iter()
        .filter(|event| event.source_record_index == 3)
        .collect::<Vec<_>>();
    assert_eq!(user_group.len(), 3);
    assert_eq!(
        user_group
            .iter()
            .map(|event| event.source_block_index)
            .collect::<Vec<_>>(),
        vec![Some(0), Some(1), Some(2)]
    );
    assert!(conversation.events.iter().any(|event| matches!(
        &event.body,
        PortableEventBody::ToolCall {
            state: PortableToolCallState::Settled,
            ..
        }
    )));
    assert!(conversation
        .events
        .iter()
        .any(|event| matches!(event.body, PortableEventBody::CompactionSummary { .. })));
    assert!(!conversation
        .events
        .iter()
        .any(|event| matches!(event.body, PortableEventBody::CompactionBoundary { .. })));
}

#[test]
fn codex_event_messages_never_become_fallback_history() {
    let temp = TempTree::new("codex-no-fallback");
    let source = codex_source(temp.path());
    write_jsonl(
        &source.source_path,
        &[
            codex_meta(),
            json!({"type": "event_msg", "payload": {"type": "user_message", "message": "UI only"}}),
        ],
    );
    let error = read_exact_imported_file(source).expect_err("UI fallback is forbidden");
    assert_eq!(error.kind, ExactReadFailureKind::UnsupportedHistoryMode);
}

#[test]
fn codex_rejects_unmatched_ui_paginated_history_encryption_and_unknown_records() {
    let cases = [
        (
            "unmatched-ui",
            vec![
                codex_meta(),
                codex_message("user", json!([{"type": "input_text", "text": "canonical"}])),
                json!({"type": "event_msg", "payload": {"type": "user_message", "message": "different"}}),
            ],
            ExactReadFailureKind::RecordSkipped,
        ),
        (
            "ui-attachments-not-proven",
            vec![
                codex_meta(),
                codex_message("user", json!([{"type": "input_text", "text": "canonical"}])),
                json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "user_message",
                        "message": "canonical",
                        "images": ["data:image/png;base64,c21hbGw="]
                    }
                }),
            ],
            ExactReadFailureKind::RecordSkipped,
        ),
        (
            "session-meta-instructions",
            vec![{
                let mut meta = codex_meta();
                meta["payload"]["instructions"] = Value::String("hidden context".to_string());
                meta
            }],
            ExactReadFailureKind::UnknownRecord,
        ),
        (
            "turn-context-instructions",
            vec![
                codex_meta(),
                codex_message("user", json!([{"type": "input_text", "text": "canonical"}])),
                json!({
                    "type": "turn_context",
                    "payload": {
                        "cwd": "/workspace/codex",
                        "instructions": "hidden context"
                    }
                }),
            ],
            ExactReadFailureKind::UnknownRecord,
        ),
        (
            "compaction-ui-before-canonical",
            vec![
                codex_meta(),
                codex_message("user", json!([{"type": "input_text", "text": "canonical"}])),
                json!({"type": "event_msg", "payload": {"type": "context_compacted"}}),
                json!({"type": "compacted", "payload": {"message": "summary"}}),
            ],
            ExactReadFailureKind::RecordSkipped,
        ),
        (
            "history-base",
            vec![{
                let mut meta = codex_meta();
                meta["payload"]["history_base"] = json!({"id": "base"});
                meta
            }],
            ExactReadFailureKind::UnsupportedHistoryMode,
        ),
        (
            "encrypted",
            vec![
                codex_meta(),
                codex_message(
                    "user",
                    json!([{"type": "input_text", "text": "ok", "encrypted_content": "secret"}]),
                ),
            ],
            ExactReadFailureKind::EncryptedContext,
        ),
        (
            "paginated",
            vec![
                codex_meta(),
                codex_message("user", json!([{"type": "input_text", "text": "ok"}])),
                json!({"type": "event_msg", "payload": {"type": "item_completed"}}),
            ],
            ExactReadFailureKind::UnsupportedHistoryMode,
        ),
        (
            "unknown",
            vec![
                codex_meta(),
                json!({"type": "future_model_record", "payload": {}}),
            ],
            ExactReadFailureKind::UnknownRecord,
        ),
    ];
    for (label, records, expected) in cases {
        let temp = TempTree::new(label);
        let source = codex_source(temp.path());
        write_jsonl(&source.source_path, &records);
        assert_eq!(
            read_exact_imported_file(source).expect_err(label).kind,
            expected,
            "{label}"
        );
    }
}

#[test]
fn codex_unknown_blocks_duplicate_and_orphan_tools_fail_closed() {
    let temp = TempTree::new("codex-tool-reject");
    let source = codex_source(temp.path());

    write_jsonl(
        &source.source_path,
        &[
            codex_meta(),
            codex_message("user", json!([{"type": "future_block", "text": "x"}])),
        ],
    );
    assert_eq!(
        read_exact_imported_file(source.clone())
            .expect_err("unknown block")
            .kind,
        ExactReadFailureKind::UnknownContentBlock
    );

    let call = json!({"type": "response_item", "payload": {"type": "function_call", "call_id": "same", "name": "shell", "arguments": "{}"}});
    write_jsonl(
        &source.source_path,
        &[
            codex_meta(),
            codex_message("user", json!([{"type": "input_text", "text": "ok"}])),
            call.clone(),
            call,
        ],
    );
    assert_eq!(
        read_exact_imported_file(source.clone())
            .expect_err("duplicate call")
            .kind,
        ExactReadFailureKind::InvalidToolLinkage
    );

    write_jsonl(
        &source.source_path,
        &[
            codex_meta(),
            codex_message("user", json!([{"type": "input_text", "text": "ok"}])),
            json!({"type": "response_item", "payload": {"type": "function_call_output", "call_id": "orphan", "output": "x"}}),
        ],
    );
    assert_eq!(
        read_exact_imported_file(source)
            .expect_err("orphan result")
            .kind,
        ExactReadFailureKind::InvalidToolLinkage
    );
}

#[test]
fn codex_session_meta_filename_id_and_verified_version_must_match() {
    let temp = TempTree::new("codex-meta-id");
    let source = codex_source(temp.path());
    for (label, mutate, expected) in [
        (
            "id",
            ("id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
            ExactReadFailureKind::InvalidSourceIdentity,
        ),
        (
            "version",
            ("cli_version", "0.145.0"),
            ExactReadFailureKind::UnsupportedHistoryMode,
        ),
    ] {
        let mut meta = codex_meta();
        meta["payload"][mutate.0] = Value::String(mutate.1.to_string());
        write_jsonl(
            &source.source_path,
            &[
                meta,
                codex_message("user", json!([{"type": "input_text", "text": "ok"}])),
            ],
        );
        assert_eq!(
            read_exact_imported_file(source.clone())
                .expect_err(label)
                .kind,
            expected
        );
    }
}

#[test]
fn source_reader_rejects_malformed_middle_unterminated_tail_and_bounds() {
    let temp = TempTree::new("source-bounds");
    let source = claude_source(temp.path());

    fs::write(&source.source_path, b"{}\nnot-json\n{}\n").expect("fixture");
    assert_eq!(
        read_source_records_with_limits(&source, ExactReadLimits::test(1024, 1024, 10))
            .expect_err("malformed middle")
            .kind,
        ExactReadFailureKind::MalformedRecord
    );

    fs::write(&source.source_path, b"{}\n{}").expect("fixture");
    assert_eq!(
        read_source_records_with_limits(&source, ExactReadLimits::test(1024, 1024, 10))
            .expect_err("unterminated tail")
            .kind,
        ExactReadFailureKind::UnterminatedTail
    );

    fs::write(&source.source_path, b"{}\n\n  \n{}\n").expect("fixture");
    assert_eq!(
        read_source_records_with_limits(&source, ExactReadLimits::test(1024, 1024, 2))
            .expect("empty lines accepted")
            .records
            .len(),
        2
    );
    assert_eq!(
        read_source_records_with_limits(&source, ExactReadLimits::test(1024, 1024, 1))
            .expect_err("record limit")
            .kind,
        ExactReadFailureKind::RecordLimit
    );
    assert_eq!(
        read_source_records_with_limits(&source, ExactReadLimits::test(5, 1024, 10))
            .expect_err("source limit")
            .kind,
        ExactReadFailureKind::SizeLimit
    );
    assert_eq!(
        read_source_records_with_limits(&source, ExactReadLimits::test(1024, 1, 10))
            .expect_err("line limit")
            .kind,
        ExactReadFailureKind::SizeLimit
    );
    fs::write(&source.source_path, b"  \n").expect("oversized blank line fixture");
    assert_eq!(
        read_source_records_with_limits(&source, ExactReadLimits::test(1024, 1, 10))
            .expect_err("blank lines remain line-bounded")
            .kind,
        ExactReadFailureKind::SizeLimit
    );
    assert_eq!(
        production_limits_for_test(),
        (64 * 1024 * 1024, 16 * 1024 * 1024, 100_000)
    );
}

#[test]
fn production_source_limits_accept_exact_64_mib_and_100k_records_only() {
    let temp = TempTree::new("production-limits");
    let source = claude_source(temp.path());
    let (source_limit, line_limit, record_limit) = production_limits_for_test();

    {
        let mut file = fs::File::create(&source.source_path).expect("64 MiB fixture");
        std::io::copy(
            &mut std::io::repeat(b'\n').take(source_limit as u64),
            &mut file,
        )
        .expect("fill exact source limit");
    }
    let exact = read_source_records_with_limits(
        &source,
        ExactReadLimits::test(source_limit, line_limit, record_limit),
    )
    .expect("exact 64 MiB accepted");
    assert!(exact.records.is_empty());
    OpenOptions::new()
        .append(true)
        .open(&source.source_path)
        .and_then(|mut file| file.write_all(b"\n"))
        .expect("extend source");
    assert_eq!(
        read_source_records_with_limits(
            &source,
            ExactReadLimits::test(source_limit, line_limit, record_limit),
        )
        .expect_err("64 MiB + 1")
        .kind,
        ExactReadFailureKind::SizeLimit
    );

    {
        let mut file = fs::File::create(&source.source_path).expect("100k fixture");
        for _ in 0..record_limit {
            file.write_all(b"{}\n").expect("record");
        }
    }
    assert_eq!(
        read_source_records_with_limits(
            &source,
            ExactReadLimits::test(source_limit, line_limit, record_limit),
        )
        .expect("exact 100k accepted")
        .records
        .len(),
        record_limit
    );
    OpenOptions::new()
        .append(true)
        .open(&source.source_path)
        .and_then(|mut file| file.write_all(b"{}\n"))
        .expect("101k fixture");
    assert_eq!(
        read_source_records_with_limits(
            &source,
            ExactReadLimits::test(source_limit, line_limit, record_limit),
        )
        .expect_err("100k + 1")
        .kind,
        ExactReadFailureKind::RecordLimit
    );
}

#[test]
fn source_mutation_and_path_swap_after_open_are_detected() {
    let temp = TempTree::new("source-race");
    let source = claude_source(temp.path());
    fs::write(&source.source_path, b"{}\n").expect("fixture");
    let mutation_path = source.source_path.clone();
    let error = read_source_records_with_open_hook(
        &source,
        ExactReadLimits::test(1024, 1024, 10),
        move || {
            OpenOptions::new()
                .append(true)
                .open(&mutation_path)
                .and_then(|mut file| file.write_all(b"{}\n"))
                .expect("mutate open source");
        },
    )
    .expect_err("mutation must fail");
    assert_eq!(error.kind, ExactReadFailureKind::SourceChanged);

    fs::write(&source.source_path, b"{}\n").expect("fixture");
    let swap_path = source.source_path.clone();
    let moved = temp.path().join("opened-original.jsonl");
    let error = read_source_records_with_open_hook(
        &source,
        ExactReadLimits::test(1024, 1024, 10),
        move || {
            fs::rename(&swap_path, &moved).expect("move original");
            fs::write(&swap_path, b"{}\n").expect("install replacement");
        },
    )
    .expect_err("path swap must fail");
    assert_eq!(error.kind, ExactReadFailureKind::SourceChanged);
}

#[cfg(unix)]
#[test]
fn source_symlinks_and_escape_are_rejected() {
    use std::os::unix::fs::symlink;

    let temp = TempTree::new("source-links");
    let outside = TempTree::new("source-outside");
    let target = outside.path().join(format!("{CLAUDE_SESSION}.jsonl"));
    fs::write(&target, b"{}\n").expect("target");
    let source = claude_source(temp.path());
    symlink(&target, &source.source_path).expect("symlink");
    assert_eq!(
        read_source_records_with_limits(&source, ExactReadLimits::test(1024, 1024, 10))
            .expect_err("symlink")
            .kind,
        ExactReadFailureKind::InvalidSourcePath
    );

    let escaped = ExactImportedFileSource {
        source_path: target,
        ..source
    };
    assert_eq!(
        read_source_records_with_limits(&escaped, ExactReadLimits::test(1024, 1024, 10))
            .expect_err("escape")
            .kind,
        ExactReadFailureKind::InvalidSourcePath
    );
}

#[test]
fn manual_import_requires_no_work_item_cloud_or_account_identity() {
    let temp = TempTree::new("manual");
    let mut source = ExactImportedFileSource::manual(
        ExactImportedSourceKind::ClaudeCode,
        CLAUDE_SESSION,
        temp.path().join(format!("{CLAUDE_SESSION}.jsonl")),
        temp.path(),
    );
    source.source_workspace_hint = Some("/stale/cache/hint".to_string());
    write_jsonl(&source.source_path, &claude_mixed_records("manual tail"));
    let before = fs::read(&source.source_path).expect("read source before import");
    let conversation = read_exact_imported_file(source.clone()).expect("manual exact import");
    assert_eq!(
        conversation.source.source_workspace_hint.as_deref(),
        Some("/workspace/原项目"),
        "authoritative transcript cwd must override rebuildable cache metadata"
    );
    assert_eq!(
        conversation.source.source_snapshot.digest,
        format!("{:x}", Sha256::digest(&before)),
        "snapshot hash and parser must consume the same captured bytes"
    );
    assert_eq!(
        conversation.source.source_snapshot.observed_bytes,
        before.len() as u64
    );
    let after = fs::read(&source.source_path).expect("read source after import");
    assert_eq!(after, before, "exact import must never mutate its source");
}

#[test]
fn poisoned_cache_lookalike_sessions_root_is_not_authority() {
    let temp = TempTree::new("poison-cache");
    let lookalike = temp.path().join("sessions");
    fs::create_dir_all(&lookalike).expect("lookalike root");
    let source_path = lookalike.join(format!("rollout-2026-08-26T00-00-00-{CODEX_THREAD}.jsonl"));
    write_jsonl(&source_path, &[codex_meta()]);

    let conn = Connection::open_in_memory().expect("db");
    conn.execute_batch(
        "CREATE TABLE imported_history_session_cache (
            session_id TEXT NOT NULL,
            source TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            source_path TEXT NOT NULL,
            name TEXT NOT NULL,
            model TEXT,
            repo_path TEXT,
            updated_at_ms INTEGER NOT NULL
        );",
    )
    .expect("schema");
    let source_key = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .expect("stem");
    let session_id = crate::sources::codex::canonical_session_id(source_key);
    conn.execute(
        "INSERT INTO imported_history_session_cache
         (session_id, source, source_session_id, source_path, name, model, repo_path, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, 'poison', NULL, NULL, 1)",
        (
            session_id.as_str(),
            SOURCE_CODEX_APP,
            source_key,
            source_path.to_string_lossy().as_ref(),
        ),
    )
    .expect("cache row");

    let error = read_exact_imported_session(&conn, &session_id).expect_err("poisoned cache");
    assert_eq!(error.kind, ExactReadFailureKind::InvalidSourcePath);
}

#[test]
fn trait_reader_rejects_descriptor_identity_mismatch() {
    let temp = TempTree::new("trait-id");
    let source = claude_source(temp.path());
    write_jsonl(&source.source_path, &claude_mixed_records("tail"));
    let error = ExactImportedTranscriptReader::new(source)
        .read_exact_visible("different")
        .expect_err("descriptor id mismatch");
    assert_eq!(error.kind, ExactReadFailureKind::InvalidSourceIdentity);
}
