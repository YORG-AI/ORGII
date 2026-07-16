//! Tests for OpenAI → Anthropic message conversion.
//!
//! Included from `messages.rs` via `#[path = "tests/messages_tests.rs"] mod tests;`
//! so `super::*` resolves to the `messages` module.

use super::*;
use serde_json::json;

#[test]
fn extract_system_single_message() {
    let messages = vec![
        json!({"role": "system", "content": "You are helpful."}),
        json!({"role": "user", "content": "Hello"}),
    ];
    let (system, msgs) = extract_system(&messages, false);
    let system = system.unwrap();
    let blocks = system.as_array().unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["text"], "You are helpful.");
    assert!(blocks[0]["cache_control"].is_object());
    assert_eq!(msgs.len(), 1);
}

#[test]
fn extract_system_multi_block_cache_control() {
    let messages = vec![
        json!({"role": "system", "content": "Stable prefix: identity, rules, tools"}),
        json!({"role": "system", "content": "Dynamic: skills, memories, scratchpad"}),
        json!({"role": "user", "content": "Hello"}),
    ];
    let (system, msgs) = extract_system(&messages, false);
    let system = system.unwrap();
    let blocks = system.as_array().unwrap();

    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0]["text"], "Stable prefix: identity, rules, tools");
    assert!(blocks[0].get("cache_control").is_none());
    assert_eq!(blocks[1]["text"], "Dynamic: skills, memories, scratchpad");
    assert!(blocks[1]["cache_control"].is_object());
    assert_eq!(msgs.len(), 1);
}

#[test]
fn extract_system_three_blocks() {
    let messages = vec![
        json!({"role": "system", "content": "Block A"}),
        json!({"role": "system", "content": "Block B"}),
        json!({"role": "system", "content": "Block C"}),
        json!({"role": "user", "content": "Hi"}),
    ];
    let (system, _) = extract_system(&messages, false);
    let blocks = system.unwrap();
    let blocks = blocks.as_array().unwrap();

    assert_eq!(blocks.len(), 3);
    assert!(blocks[0].get("cache_control").is_none());
    assert!(blocks[1].get("cache_control").is_none());
    assert!(blocks[2]["cache_control"].is_object());
}

#[test]
fn extract_system_structured_compacted_baseline_keeps_session_cache_control() {
    let messages = vec![
        json!({
            "role": "system",
            "content": [{
                "type": "text",
                "text": "[Conversation summary — 4 earlier messages compacted]\n\nDone",
                (crate::session::prompt::cache::ORGII_SYSTEM_CACHE_SCOPE_KEY): "session"
            }]
        }),
        json!({"role": "user", "content": "continue"}),
    ];

    let (system, msgs) = extract_system(&messages, false);
    let blocks = system.unwrap();
    let blocks = blocks.as_array().unwrap();

    assert_eq!(blocks.len(), 1);
    assert_eq!(
        blocks[0]["text"],
        "[Conversation summary — 4 earlier messages compacted]\n\nDone"
    );
    assert_eq!(blocks[0]["cache_control"]["type"], "ephemeral");
    assert_eq!(msgs.len(), 1);
}

#[test]
fn extract_system_no_system_messages() {
    let messages = vec![json!({"role": "user", "content": "Hello"})];
    let (system, msgs) = extract_system(&messages, false);
    assert!(system.is_none());
    assert_eq!(msgs.len(), 1);
}

#[test]
fn extract_system_skips_empty_system_blocks_before_cache_control() {
    let messages = vec![
        json!({"role": "system", "content": ""}),
        json!({"role": "system", "content": "   "}),
        json!({"role": "system", "content": "Stable instructions"}),
        json!({"role": "user", "content": "Hello"}),
    ];
    let (system, msgs) = extract_system(&messages, false);
    let system = system.expect("non-empty system block remains");
    let blocks = system.as_array().expect("system is structured blocks");

    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["text"], "Stable instructions");
    assert_eq!(blocks[0]["cache_control"]["type"], "ephemeral");
    assert_eq!(msgs.len(), 1);
}

/// The last content block of the last converted message must carry
/// `cache_control: ephemeral`. Without this the message history is
/// re-tokenised every turn even though system + tools are cached.
#[test]
fn extract_system_stamps_history_tail_breakpoint() {
    let messages = vec![
        json!({"role": "system", "content": "sys"}),
        json!({"role": "user", "content": "what time is it?"}),
        json!({"role": "assistant", "content": "Let me check."}),
        json!({"role": "user", "content": "thanks"}),
    ];
    let (_system, converted) = extract_system(&messages, false);
    let last = converted.last().unwrap();
    let blocks = last["content"].as_array().unwrap();
    let last_block = blocks.last().unwrap();
    assert!(
        last_block["cache_control"].is_object(),
        "last content block must have cache_control: {}",
        serde_json::to_string_pretty(last).unwrap(),
    );
    assert_eq!(last_block["cache_control"]["type"], "ephemeral");
}

/// Earlier messages' content blocks must NOT have cache_control —
/// only the trailing block is stamped, so the breakpoint slides
/// forward as the conversation grows.
#[test]
fn extract_system_earlier_blocks_have_no_cache_control() {
    let messages = vec![
        json!({"role": "system", "content": "sys"}),
        json!({"role": "user", "content": "first"}),
        json!({"role": "assistant", "content": "answer"}),
        json!({"role": "user", "content": "second"}),
    ];
    let (_system, converted) = extract_system(&messages, false);
    let tail_idx = converted.len() - 1;
    for (idx, msg) in converted.iter().enumerate() {
        if idx == tail_idx {
            continue;
        }
        let blocks = msg["content"].as_array().unwrap();
        for block in blocks {
            assert!(
                block.get("cache_control").is_none(),
                "non-trailing block unexpectedly has cache_control at idx={}: {}",
                idx,
                serde_json::to_string(block).unwrap()
            );
        }
    }
}

#[test]
fn extract_system_stamp_is_noop_when_empty() {
    let messages = vec![json!({"role": "system", "content": "sys"})];
    let (_system, converted) = extract_system(&messages, false);
    assert!(converted.is_empty());
}

/// `skip_cache_write: true` must suppress BOTH message-side breakpoints:
/// BP1 (last cacheable system block) and BP3 (history tail). One-shot side
/// queries never re-read the cached prefix, so any stamp is pure
/// cache-write premium.
#[test]
fn extract_system_skip_cache_write_stamps_no_breakpoints() {
    let messages = vec![
        json!({"role": "system", "content": "sys"}),
        json!({"role": "user", "content": "first"}),
        json!({"role": "assistant", "content": "answer"}),
        json!({"role": "user", "content": "second"}),
    ];
    let (system, converted) = extract_system(&messages, true);

    let system = system.unwrap();
    for block in system.as_array().unwrap() {
        assert!(
            block.get("cache_control").is_none(),
            "BP1 must be suppressed: {}",
            serde_json::to_string(block).unwrap()
        );
    }
    for msg in &converted {
        for block in msg["content"].as_array().unwrap() {
            assert!(
                block.get("cache_control").is_none(),
                "BP3 must be suppressed: {}",
                serde_json::to_string(block).unwrap()
            );
        }
    }
}

#[test]
fn extract_system_restores_anthropic_thinking_before_tool_use() {
    let messages = vec![
        json!({"role": "user", "content": "hi"}),
        json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "toolu_1",
                "type": "function",
                "function": {"name": "read_file", "arguments": "{\"path\":\"package.json\"}"},
                "extra_content": {
                    "anthropic": {
                        "thinking": "I should inspect the file.",
                        "signature": "sig_abc"
                    }
                }
            }]
        }),
    ];

    let (_system, converted) = extract_system(&messages, false);
    let assistant = converted.last().unwrap();
    assert_eq!(assistant["role"].as_str().unwrap(), "assistant");
    let blocks = assistant["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0]["type"].as_str().unwrap(), "thinking");
    assert_eq!(
        blocks[0]["thinking"].as_str().unwrap(),
        "I should inspect the file."
    );
    assert_eq!(blocks[0]["signature"].as_str().unwrap(), "sig_abc");
    assert_eq!(blocks[1]["type"].as_str().unwrap(), "tool_use");
    assert_eq!(blocks[1]["id"].as_str().unwrap(), "toolu_1");
}

#[test]
fn extract_system_tool_message_without_sidecar_is_unchanged() {
    let messages = vec![
        json!({"role": "user", "content": "hi"}),
        json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "tc_1",
                "type": "function",
                "function": {"name": "my_tool", "arguments": "{}"}
            }]
        }),
        json!({
            "role": "tool",
            "tool_call_id": "tc_1",
            "name": "my_tool",
            "content": "plain result string"
        }),
    ];
    let (_system, converted) = extract_system(&messages, false);
    let last = converted.last().unwrap();
    assert_eq!(last["role"].as_str().unwrap(), "user");
    let blocks = last["content"].as_array().unwrap();
    assert_eq!(
        blocks.len(),
        1,
        "no sidecar → exactly one tool_result block (sidecar-less baseline)"
    );
    assert_eq!(blocks[0]["type"].as_str().unwrap(), "tool_result");
    assert_eq!(blocks[0]["tool_use_id"].as_str().unwrap(), "tc_1");
    assert_eq!(
        blocks[0]["content"].as_str().unwrap(),
        "plain result string"
    );
    assert!(
        blocks[0].get("is_error").is_none(),
        "non-error tool_result must not carry is_error in the wire payload"
    );
}

#[test]
fn extract_system_tool_message_with_is_error_meta_emits_is_error_true() {
    // Mirrors the in-memory shape `add_tool_result*` writes when a
    // tool returns an error string. The Anthropic-native wire emitter
    // must promote `_orgii_is_error: true` to a top-level
    // `is_error: true` on the tool_result block — without it the
    // model treats the failed tool result as a successful return,
    // which leads to hallucinated follow-ups ("Great, the file was
    // written!") and is the canonical
    // "wire-payload schema lies" wiring-checklist failure mode.
    let messages = vec![
        json!({"role": "user", "content": "hi"}),
        json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "tc_err",
                "type": "function",
                "function": {"name": "my_tool", "arguments": "{}"}
            }]
        }),
        json!({
            "role": "tool",
            "tool_call_id": "tc_err",
            "name": "my_tool",
            "content": "Error: permission denied",
            "_orgii_is_error": true,
        }),
    ];
    let (_system, converted) = extract_system(&messages, false);
    let last = converted.last().unwrap();
    let blocks = last["content"].as_array().unwrap();
    assert_eq!(blocks[0]["type"].as_str().unwrap(), "tool_result");
    assert_eq!(
        blocks[0]["is_error"].as_bool(),
        Some(true),
        "_orgii_is_error: true must be promoted to wire-level is_error: true"
    );
    assert_eq!(
        blocks[0]["content"].as_str().unwrap(),
        "Error: permission denied"
    );
    assert!(
        blocks[0].get("_orgii_is_error").is_none(),
        "internal meta key must not leak onto the Anthropic wire block"
    );
}

#[test]
fn extract_system_tool_message_with_image_sidecar_emits_sibling_image() {
    let messages = vec![json!({
        "role": "tool",
        "tool_call_id": "tc_img",
        "name": "mcp__screenshot",
        "content": "Captured. Image attached.",
        "_orgii_structured": {
            "content_blocks": [
                {
                    "type": "image",
                    "mime_type": "image/png",
                    "data": "iVBORw0KG..."
                }
            ]
        }
    })];
    let (_system, converted) = extract_system(&messages, false);
    let last = converted.last().unwrap();
    let blocks = last["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 2, "tool_result + sibling image block");
    assert_eq!(blocks[0]["type"].as_str().unwrap(), "tool_result");
    assert_eq!(
        blocks[0]["content"].as_str().unwrap(),
        "Captured. Image attached."
    );
    assert_eq!(blocks[1]["type"].as_str().unwrap(), "image");
    assert_eq!(blocks[1]["source"]["type"].as_str().unwrap(), "base64");
    assert_eq!(
        blocks[1]["source"]["media_type"].as_str().unwrap(),
        "image/png"
    );
    assert_eq!(
        blocks[1]["source"]["data"].as_str().unwrap(),
        "iVBORw0KG..."
    );
}

#[test]
fn extract_system_multiple_images_in_sidecar_all_become_siblings() {
    let messages = vec![json!({
        "role": "tool",
        "tool_call_id": "tc_multi",
        "name": "mcp__multi_shot",
        "content": "3 images captured",
        "_orgii_structured": {
            "content_blocks": [
                {"type": "image", "mime_type": "image/jpeg", "data": "aaa"},
                {"type": "image", "mime_type": "image/png", "data": "bbb"},
                {"type": "image", "mime_type": "image/png", "data": "ccc"},
            ]
        }
    })];
    let (_system, converted) = extract_system(&messages, false);
    let blocks = converted.last().unwrap()["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 4, "tool_result + 3 images");
    assert_eq!(blocks[0]["type"].as_str().unwrap(), "tool_result");
    for block in blocks.iter().skip(1).take(3) {
        assert_eq!(block["type"].as_str().unwrap(), "image");
    }
}

#[test]
fn extract_system_audio_block_degrades_to_text_breadcrumb() {
    let messages = vec![json!({
        "role": "tool",
        "tool_call_id": "tc_audio",
        "name": "mcp__record",
        "content": "Recording complete",
        "_orgii_structured": {
            "content_blocks": [
                {"type": "audio", "mime_type": "audio/wav", "data": "abc"}
            ]
        }
    })];
    let (_system, converted) = extract_system(&messages, false);
    let blocks = converted.last().unwrap()["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[1]["type"].as_str().unwrap(), "text");
    assert!(blocks[1]["text"]
        .as_str()
        .unwrap()
        .contains("audio payload attached"));
}

#[test]
fn extract_system_resource_block_degrades_to_text_with_uri() {
    let messages = vec![json!({
        "role": "tool",
        "tool_call_id": "tc_res",
        "name": "mcp__read",
        "content": "Found spec",
        "_orgii_structured": {
            "content_blocks": [
                {
                    "type": "resource",
                    "uri": "file:///tmp/spec.md",
                    "mime_type": "text/markdown",
                    "text": "# Spec\nhi"
                }
            ]
        }
    })];
    let (_system, converted) = extract_system(&messages, false);
    let blocks = converted.last().unwrap()["content"].as_array().unwrap();
    let breadcrumb = blocks[1]["text"].as_str().unwrap();
    assert!(breadcrumb.contains("file:///tmp/spec.md"));
    assert!(breadcrumb.contains("# Spec"));
}

#[test]
fn extract_system_sidecar_with_only_meta_emits_no_extra_blocks() {
    let messages = vec![json!({
        "role": "tool",
        "tool_call_id": "tc_meta",
        "name": "mcp__analyze",
        "content": "ok",
        "_orgii_structured": {
            "mcp_meta": { "meta": { "request_id": "r-7" } }
        }
    })];
    let (_system, converted) = extract_system(&messages, false);
    let blocks = converted.last().unwrap()["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["type"].as_str().unwrap(), "tool_result");
}

#[test]
fn extract_system_merges_consecutive_tool_messages_with_sidecars() {
    let messages = vec![
        json!({
            "role": "tool",
            "tool_call_id": "tc_a",
            "name": "mcp__a",
            "content": "A result",
            "_orgii_structured": {
                "content_blocks": [
                    {"type": "image", "mime_type": "image/png", "data": "AAA"}
                ]
            }
        }),
        json!({
            "role": "tool",
            "tool_call_id": "tc_b",
            "name": "mcp__b",
            "content": "B result",
        }),
    ];
    let (_system, converted) = extract_system(&messages, false);
    assert_eq!(
        converted.len(),
        1,
        "both tool messages merged into one user"
    );
    let blocks = converted[0]["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0]["type"].as_str().unwrap(), "tool_result");
    assert_eq!(blocks[0]["tool_use_id"].as_str().unwrap(), "tc_a");
    assert_eq!(blocks[1]["type"].as_str().unwrap(), "image");
    assert_eq!(blocks[2]["type"].as_str().unwrap(), "tool_result");
    assert_eq!(blocks[2]["tool_use_id"].as_str().unwrap(), "tc_b");
}

#[test]
fn sidecar_to_sibling_blocks_ignores_unknown_types() {
    let sidecar = json!({
        "content_blocks": [
            {"type": "some_future_type", "data": "x"},
            {"type": "image", "mime_type": "image/png", "data": "YYY"}
        ]
    });
    let blocks = sidecar_to_anthropic_sibling_blocks(&sidecar).unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["type"].as_str().unwrap(), "image");
}

#[test]
fn sidecar_to_sibling_blocks_returns_none_on_empty_or_missing() {
    assert!(sidecar_to_anthropic_sibling_blocks(&json!({})).is_none());
    assert!(sidecar_to_anthropic_sibling_blocks(&json!({
        "content_blocks": []
    }))
    .is_none());
    assert!(sidecar_to_anthropic_sibling_blocks(&json!({
        "content_blocks": [{"type": "text", "text": "already flattened"}]
    }))
    .is_none());
}
