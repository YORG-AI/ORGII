use super::*;
use serde_json::json;

fn assert_replayable_signed_summary(tool_calls: &[crate::providers::traits::ToolCallRequest]) {
    assert_eq!(tool_calls.len(), 1);
    let call = &tool_calls[0];
    assert_eq!(
        call.thought_signature,
        Some(json!({
            "anthropic": { "thinking": "", "signature": "opaque-signature" }
        }))
    );

    // The turn executor persists this extra_content shape without modifying
    // it; run it through the next request's history conversion as well.
    let (_, messages) = super::super::messages::extract_system(
        &[
            json!({"role": "user", "content": "Read the file"}),
            json!({"role": "assistant", "content": null, "tool_calls": [{
                "id": call.id, "type": "function",
                "function": {"name": call.name, "arguments": call.arguments.to_string()},
                "extra_content": call.thought_signature
            }]}),
        ],
        true,
    );
    assert_eq!(
        messages[1]["content"][0],
        json!({
            "type": "thinking", "thinking": "", "signature": "opaque-signature"
        })
    );
    assert_eq!(messages[1]["content"][1]["type"], "tool_use");
}

#[test]
fn non_streaming_empty_signed_summary_survives_ingestion_and_replay() {
    let parsed: MessagesResponse = serde_json::from_value(json!({
        "content": [
            {"type": "thinking", "thinking": "", "signature": "opaque-signature"},
            {"type": "tool_use", "id": "call_1", "name": "read_file", "input": {"path": "README.md"}}
        ],
        "stop_reason": "tool_use"
    })).unwrap();
    let response = build_non_streaming_response(parsed);
    assert_replayable_signed_summary(&response.tool_calls);
    assert!(response.reasoning_content.is_none());
    assert_eq!(
        response.blocks.len(),
        1,
        "no empty reasoning row is rendered"
    );
}

#[test]
fn streamed_signature_without_thinking_text_survives_ingestion_and_replay() {
    let mut state = StreamState::default();
    for frame in [
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "opaque-signature"}}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "call_1", "name": "read_file", "input": {}}}),
        json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"path\":\"README.md\"}"}}),
        json!({"type": "content_block_stop", "index": 1}),
    ] {
        handle_event(
            serde_json::from_value(frame).unwrap(),
            &mut state,
            &|_| {},
            "claude-fable-5-1",
        );
    }
    let (blocks, tool_calls) = finalize_blocks(&mut state);
    assert_replayable_signed_summary(&tool_calls);
    assert!(
        state.block_accumulators.is_empty(),
        "finalization drains per-response state"
    );
    assert_eq!(blocks.len(), 1, "no empty reasoning row is rendered");
}
