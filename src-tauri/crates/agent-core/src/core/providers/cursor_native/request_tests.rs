use super::*;
use serde_json::json;

fn extract_run(msg: &pb::AgentClientMessage) -> &pb::AgentRunRequest {
    match &msg.message {
        Some(pb::agent_client_message::Message::RunRequest(r)) => r,
        _ => panic!("expected RunRequest variant"),
    }
}

fn current_user_text(run: &pb::AgentRunRequest) -> &str {
    match &run.action.as_ref().unwrap().action {
        Some(pb::conversation_action::Action::UserMessageAction(action)) => {
            &action.user_message.as_ref().unwrap().text
        }
        _ => panic!("expected UserMessageAction"),
    }
}

fn is_resume_action(run: &pb::AgentRunRequest) -> bool {
    matches!(
        run.action
            .as_ref()
            .and_then(|action| action.action.as_ref()),
        Some(pb::conversation_action::Action::ResumeAction(_))
    )
}

/// Single user message: the entire system is empty, the one message
/// becomes the current user turn, no history.
#[test]
fn single_user_message_becomes_current_turn() {
    let messages = vec![json!({"role": "user", "content": "hello"})];
    let built = build_run_request(&messages, "default");
    let run = extract_run(&built.client_message);

    assert_eq!(current_user_text(run), "hello");
    let state = run.conversation_state.as_ref().unwrap();
    assert!(state.turns.is_empty(), "no prior history");
    assert_eq!(state.root_prompt_messages_json.len(), 1);
}

/// System prompt is stored as a blob; the blob ID matches what the
/// server will later ask for via GetBlobArgs.
#[test]
fn system_prompt_is_sha256_blob() {
    let messages = vec![
        json!({"role": "system", "content": "you are helpful"}),
        json!({"role": "user", "content": "hi"}),
    ];
    let built = build_run_request(&messages, "default");
    let run = extract_run(&built.client_message);

    let state = run.conversation_state.as_ref().unwrap();
    let blob_id = state.root_prompt_messages_json.first().expect("has id");
    assert_eq!(blob_id.len(), 32, "SHA-256 produces 32 bytes");

    // blob_id must key into the blob store with the exact bytes we
    // told the server about — otherwise GetBlobArgs will miss.
    let stored = built.blobs.get(blob_id).expect("blob present");
    let wrapper: serde_json::Value = serde_json::from_slice(stored).unwrap();
    assert_eq!(wrapper["role"], "system");
    assert_eq!(wrapper["content"], "you are helpful");
}

/// Multi-turn history without tool calls: every completed (user,
/// assistant) pair becomes one encoded turn blob whose single step is
/// the assistant text; the current user message is the unpaired
/// trailing user.
#[test]
fn history_splits_into_pairs() {
    let messages = vec![
        json!({"role": "user", "content": "u1"}),
        json!({"role": "assistant", "content": "a1"}),
        json!({"role": "user", "content": "u2"}),
        json!({"role": "assistant", "content": "a2"}),
        json!({"role": "user", "content": "u3"}),
    ];
    let built = build_run_request(&messages, "default");
    let run = extract_run(&built.client_message);

    let state = run.conversation_state.as_ref().unwrap();
    assert_eq!(state.turns.len(), 2, "two completed pairs");
    assert_eq!(current_user_text(run), "u3");

    // Each turn reference should point to a blob that decodes back to a
    // ConversationTurnStructure with matching user + assistant text.
    for (i, (expected_u, expected_a)) in [("u1", "a1"), ("u2", "a2")].iter().enumerate() {
        let turn_blob_id = &state.turns[i];
        assert_eq!(turn_blob_id.len(), 32, "turns are SHA-256 blob ids");
        let turn_bytes = built.blobs.get(turn_blob_id).expect("turn blob present");
        let turn =
            pb::ConversationTurnStructure::decode(turn_bytes.as_slice()).expect("turn decodes");
        let agent = match turn.turn.unwrap() {
            pb::conversation_turn_structure::Turn::AgentConversationTurn(a) => a,
            _ => panic!("expected agent turn"),
        };
        assert_eq!(agent.user_message.len(), 32, "user_message is a blob id");
        let user_bytes = built
            .blobs
            .get(&agent.user_message)
            .expect("user message blob present");
        let user = pb::UserMessage::decode(user_bytes.as_slice()).unwrap();
        assert_eq!(user.text, *expected_u);
        assert_eq!(agent.steps.len(), 1, "one assistant step");
        assert_eq!(agent.steps[0].len(), 32, "step is a blob id");
        let step_bytes = built.blobs.get(&agent.steps[0]).expect("step blob present");
        let step = pb::ConversationStep::decode(step_bytes.as_slice()).unwrap();
        match step.message.unwrap() {
            pb::conversation_step::Message::AssistantMessage(m) => {
                assert_eq!(m.text, *expected_a);
            }
            _ => panic!("expected AssistantMessage"),
        }
    }
}

/// Structured content array (OpenAI multimodal shape) flattens into
/// newline-joined text — images and non-text parts are dropped for
/// text-only Cursor. Text segments are separated by '\n' to match the
/// multi-assistant-message join behaviour in `split_messages`.
#[test]
fn structured_content_flattens_to_text() {
    let messages = vec![json!({
        "role": "user",
        "content": [
            {"type": "text", "text": "hello"},
            {"type": "image_url", "image_url": {"url": "data:..."}},
            {"type": "text", "text": "world"}
        ]
    })];
    let built = build_run_request(&messages, "default");
    assert_eq!(
        current_user_text(extract_run(&built.client_message)),
        "hello\nworld"
    );
}

/// Final message is assistant (rare — resume/re-run): re-use the
/// preceding user text as the "current" so Cursor gets a user-style
/// action to respond to. Matches opencode-cursor proxy.ts:569-572.
#[test]
fn trailing_assistant_replays_previous_user() {
    let messages = vec![
        json!({"role": "user", "content": "ask"}),
        json!({"role": "assistant", "content": "answer"}),
    ];
    let built = build_run_request(&messages, "default");
    assert_eq!(current_user_text(extract_run(&built.client_message)), "ask");
    // And turns is empty because the only pair got consumed.
    let state = extract_run(&built.client_message)
        .conversation_state
        .as_ref()
        .unwrap();
    assert!(state.turns.is_empty());
}

/// Model ID is mirrored into displayModelId and displayName — Cursor
/// accepts either-or, but sending just model_id empirically causes some
/// model routing fallback paths to misfire.
#[test]
fn model_id_populates_display_fields() {
    let messages = vec![json!({"role": "user", "content": "x"})];
    let built = build_run_request(&messages, "composer-1");
    let details = extract_run(&built.client_message)
        .model_details
        .as_ref()
        .unwrap();
    assert_eq!(details.model_id, "composer-1");
    assert_eq!(details.display_model_id, "composer-1");
    assert_eq!(details.display_name, "composer-1");
}

/// Empty `messages` is a degenerate case (no system, no user).
/// We still produce a valid wire-ready message rather than panicking —
/// the caller is responsible for sanity input.
#[test]
fn empty_messages_produces_empty_turn() {
    let built = build_run_request(&[], "default");
    let run = extract_run(&built.client_message);
    assert_eq!(current_user_text(run), "");
    assert!(run.conversation_state.as_ref().unwrap().turns.is_empty());
}

/// Assistant-with-tool-calls + tool result pair is replayed as a single
/// turn whose steps list contains `AssistantMessage` + `ToolCall
/// (McpToolCall)`. This is the load-bearing path for multi-turn agent
/// conversations with tools: if it breaks, the server sees the tool
/// call as never-happened and the model loops.
#[test]
fn tool_call_history_flows_into_turn_steps() {
    let messages = vec![
        json!({"role": "user", "content": "search rust"}),
        json!({
            "role": "assistant",
            "content": "sure",
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {
                    "name": "web_search",
                    "arguments": "{\"query\":\"rust\"}"
                }
            }]
        }),
        json!({
            "role": "tool",
            "tool_call_id": "call_1",
            "content": "found 3 links"
        }),
        json!({"role": "user", "content": "pick one"}),
    ];
    let built = build_run_request(&messages, "default");
    let run = extract_run(&built.client_message);
    let state = run.conversation_state.as_ref().unwrap();

    assert_eq!(state.turns.len(), 1);
    assert_eq!(current_user_text(run), "pick one");

    let turn_bytes = built.blobs.get(&state.turns[0]).expect("turn blob present");
    let turn = pb::ConversationTurnStructure::decode(turn_bytes.as_slice()).unwrap();
    let agent = match turn.turn.unwrap() {
        pb::conversation_turn_structure::Turn::AgentConversationTurn(a) => a,
        _ => panic!("expected agent turn"),
    };
    assert_eq!(
        agent.steps.len(),
        1,
        "tool exchange is replayed as one tool step"
    );

    assert_eq!(agent.steps[0].len(), 32, "step0 is a blob id");
    let step0_bytes = built
        .blobs
        .get(&agent.steps[0])
        .expect("step0 blob present");
    let step0 = pb::ConversationStep::decode(step0_bytes.as_slice()).unwrap();
    match step0.message.unwrap() {
        pb::conversation_step::Message::ToolCall(tc) => match tc.tool.unwrap() {
            pb::tool_call::Tool::McpToolCall(mcp) => {
                let args = mcp.args.unwrap();
                assert_eq!(args.tool_call_id, "call_1");
                assert_eq!(args.tool_name, "web_search");
                assert!(mcp.result.is_some(), "tool result embedded");
            }
            _ => panic!("expected McpToolCall"),
        },
        _ => panic!("expected ToolCall step"),
    }
}

#[test]
fn second_user_after_tool_history_stays_user_action() {
    let messages = vec![
        json!({"role": "user", "content": "inspect files"}),
        json!({
            "role": "assistant",
            "content": "I will list the directory.",
            "tool_calls": [{
                "id": "call_ls",
                "type": "function",
                "function": {"name": "list_dir", "arguments": "{\"path\":\".\"}"}
            }]
        }),
        json!({
            "role": "tool",
            "tool_call_id": "call_ls",
            "content": "Cargo.toml\nREADME.md"
        }),
        json!({"role": "user", "content": "now summarize what you saw"}),
    ];

    let built = build_run_request(&messages, "composer-2");
    let run = extract_run(&built.client_message);
    assert_eq!(current_user_text(run), "now summarize what you saw");
    assert!(!is_resume_action(run));
    assert_eq!(run.conversation_state.as_ref().unwrap().turns.len(), 1);
}

#[test]
fn agent_tool_result_history_continues_with_task_result_context() {
    let messages = vec![
        json!({"role": "user", "content": "Use explore and report marker"}),
        json!({
            "role": "assistant",
            "content": "Launching explore.",
            "tool_calls": [{
                "id": "call_agent",
                "type": "function",
                "function": {
                    "name": tool_names::AGENT,
                    "arguments": "{\"agent_id\":\"builtin:explore\",\"prompt\":\"read marker\"}"
                }
            }]
        }),
        json!({
            "role": "tool",
            "tool_call_id": "call_agent",
            "content": "CURSOR_NATIVE_SUBAGENT_MARKER=opal-subagent-731"
        }),
    ];

    let built = build_run_request(&messages, "composer-2");
    let run = extract_run(&built.client_message);
    assert!(!is_resume_action(run));
    let text = current_user_text(run);
    assert!(text.contains("Continue answering the original user request"));
    assert!(text.contains("opal-subagent-731"));
}

/// Cold-start replay after a completed tool exchange uses an explicit
/// simulated continuation so Cursor cannot attach unrelated server state.
#[test]
fn tool_result_history_replay_uses_simulated_continuation() {
    let prompt = "Inspect this repository and summarize its purpose.";
    let messages = vec![
        json!({"role": "user", "content": prompt}),
        json!({
            "role": "assistant",
            "content": "I will inspect the repository files.",
            "tool_calls": [{
                "id": "call_explore",
                "type": "function",
                "function": {"name": "list_dir", "arguments": "{\"path\":\".\"}"}
            }]
        }),
        json!({
            "role": "tool",
            "tool_call_id": "call_explore",
            "content": "Cargo.toml\nREADME.md"
        }),
    ];

    let built = build_run_request(&messages, "composer-2");
    let run = extract_run(&built.client_message);
    let state = run.conversation_state.as_ref().unwrap();

    assert_eq!(state.turns.len(), 1);
    assert!(!is_resume_action(run));
    let text = current_user_text(run);
    assert!(text.contains("Continue answering the original user request"));
    assert!(text.contains(prompt));
    assert!(text.contains("Cargo.toml"));
}

/// Assistant tool-call without a preceding user (multi-step tool reply)
/// gets stitched onto the in-flight assistant turn rather than dropped.
#[test]
fn multi_step_assistant_tool_calls_stitch_onto_same_turn() {
    let messages = vec![
        json!({"role": "user", "content": "do two things"}),
        json!({
            "role": "assistant",
            "content": "step 1",
            "tool_calls": [{
                "id": "a",
                "type": "function",
                "function": {"name": "t", "arguments": "{}"}
            }]
        }),
        json!({"role": "tool", "tool_call_id": "a", "content": "r1"}),
        json!({
            "role": "assistant",
            "content": "step 2",
            "tool_calls": [{
                "id": "b",
                "type": "function",
                "function": {"name": "t", "arguments": "{}"}
            }]
        }),
        json!({"role": "tool", "tool_call_id": "b", "content": "r2"}),
    ];
    let built = build_run_request(&messages, "default");
    let run = extract_run(&built.client_message);
    let state = run.conversation_state.as_ref().unwrap();

    // No new user message; the in-flight assistant turn flushes to
    // history and the current action carries an explicit simulated
    // continuation with the original request and completed results.
    assert_eq!(state.turns.len(), 1);
    assert!(!is_resume_action(run));
    assert!(current_user_text(run).contains("Continue answering the original user request"));
    let turn_bytes = built.blobs.get(&state.turns[0]).expect("turn blob present");
    let turn = pb::ConversationTurnStructure::decode(turn_bytes.as_slice()).unwrap();
    let agent = match turn.turn.unwrap() {
        pb::conversation_turn_structure::Turn::AgentConversationTurn(a) => a,
        _ => panic!("expected agent turn"),
    };
    assert_eq!(agent.steps.len(), 2, "both tool calls are replayed");
    for step_id in &agent.steps {
        let step_bytes = built.blobs.get(step_id).expect("step blob present");
        let step = pb::ConversationStep::decode(step_bytes.as_slice()).unwrap();
        assert!(matches!(
            step.message,
            Some(pb::conversation_step::Message::ToolCall(_))
        ));
    }
}

/// The returned AgentClientMessage must actually round-trip through
/// prost encode/decode — catches any schema mismatches or required
/// fields we forgot to set.
#[test]
fn built_message_round_trips_through_prost() {
    let messages = vec![
        json!({"role": "system", "content": "sys"}),
        json!({"role": "user", "content": "u1"}),
        json!({"role": "assistant", "content": "a1"}),
        json!({"role": "user", "content": "u2"}),
    ];
    let built = build_run_request(&messages, "default");
    let mut buf = Vec::with_capacity(built.client_message.encoded_len());
    built.client_message.encode(&mut buf).unwrap();
    let decoded = pb::AgentClientMessage::decode(buf.as_slice()).unwrap();
    assert_eq!(current_user_text(extract_run(&decoded)), "u2");
}
