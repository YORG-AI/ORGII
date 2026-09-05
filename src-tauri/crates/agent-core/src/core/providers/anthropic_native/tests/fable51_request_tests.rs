//! Serialized request contracts from the Fable 5.1 migration guide.
use super::*;
use crate::providers::registry::find_by_name;
use crate::providers::traits::ProviderConfig;
use std::collections::HashMap;

fn client(auth_mode: AnthropicAuthMode, extra_headers: HashMap<String, String>) -> AnthropicClient {
    crate::test_support::install_crypto_provider_for_tests();
    AnthropicClient::new_with_auth_mode(
        ProviderConfig {
            api_key: "test-key".into(),
            api_base: Some("https://example.invalid/v1".into()),
            extra_headers,
            is_azure: auth_mode == AnthropicAuthMode::AzureBearer,
        },
        find_by_name("anthropic").unwrap(),
        "claude-fable-5-1".into(),
        auth_mode,
    )
}

fn serialized_request(
    client: &AnthropicClient,
    model: &str,
    messages: &[Value],
    tools: Option<&[Value]>,
    stream: bool,
) -> (Value, reqwest::header::HeaderMap) {
    let prepared = prepare_request(client, messages, tools, model, 8192, 0.7, stream, true);
    let request = apply_headers(
        client,
        &prepared.resolved_model,
        client.client.post(&prepared.url),
    )
    .json(&prepared.body)
    .build()
    .unwrap();
    let body = serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
    (body, request.headers().clone())
}

fn tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "emit_result",
            "description": "Emit structured output",
            "parameters": { "type": "object", "properties": { "answer": { "type": "string" } } }
        }
    })
}

fn tools_with_choice(choice: Value) -> Vec<Value> {
    vec![
        tool(),
        json!({ (crate::core::side_query::TOOL_CHOICE_OVERRIDE_KEY): choice }),
    ]
}

#[test]
fn documented_efforts_reach_wire_in_all_auth_and_stream_modes() {
    for auth in [
        AnthropicAuthMode::ApiKey,
        AnthropicAuthMode::AzureBearer,
        AnthropicAuthMode::ClaudeOauth,
    ] {
        let client = client(auth, HashMap::new());
        for stream in [false, true] {
            for effort in ["low", "medium", "high", "xhigh", "max"] {
                // Both plain side queries and normal tool-enabled chat must
                // honor the chosen effort and always-on thinking.
                for tools in [None, Some(vec![tool()])] {
                    let (body, headers) = serialized_request(
                        &client,
                        &format!("claude-fable-5-1-{effort}"),
                        &[json!({"role": "user", "content": "hello"})],
                        tools.as_deref(),
                        stream,
                    );
                    assert_eq!(body["model"], "claude-fable-5-1");
                    assert_eq!(body["stream"], stream);
                    assert_eq!(body["output_config"], json!({"effort": effort}));
                    assert_eq!(
                        body["thinking"],
                        json!({
                            "type": "adaptive", "display": "summarized",
                            "block_binding": {"prefix_mismatch_behavior": "drop_block"}
                        })
                    );
                    assert!(body.get("temperature").is_none());
                    assert!(body.get("effort").is_none());
                    assert_eq!(headers.get_all("anthropic-beta").iter().count(), 1);
                    assert!(headers["anthropic-beta"]
                        .to_str()
                        .unwrap()
                        .split(',')
                        .any(|v| v == THINKING_BINDING_BETA));
                    match auth {
                        AnthropicAuthMode::ApiKey => assert_eq!(headers["x-api-key"], "test-key"),
                        _ => assert_eq!(headers["authorization"], "Bearer test-key"),
                    }
                }
            }
        }
    }
}

#[test]
fn saved_aliases_and_baseline_never_disable_fable_51_thinking() {
    let client = client(AnthropicAuthMode::ApiKey, HashMap::new());
    for (suffix, effort) in [
        ("", None),
        ("-baseline", None),
        ("-thinking-none", None),
        ("-ultracode", Some("max")),
        ("-thinking-ultracode", Some("max")),
    ] {
        let (body, _) = serialized_request(
            &client,
            &format!("claude-fable-5-1{suffix}"),
            &[],
            None,
            false,
        );
        assert_eq!(body["model"], "claude-fable-5-1");
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["output_config"]["effort"].as_str(), effort);
    }
}

#[test]
fn forced_choices_become_auto_with_current_turn_instructions() {
    let client = client(AnthropicAuthMode::ApiKey, HashMap::new());
    let messages = vec![json!({"role": "user", "content": "Extract the answer"})];
    for choice in [
        json!({"type": "tool", "name": "emit_result"}),
        json!({"type": "any"}),
    ] {
        let tools = tools_with_choice(choice.clone());
        let original_tools = tools.clone();
        for stream in [false, true] {
            let (body, _) = serialized_request(
                &client,
                "claude-fable-5-1-high",
                &messages,
                Some(&tools),
                stream,
            );
            assert_eq!(body["tool_choice"], json!({"type": "auto"}));
            assert_eq!(body["tools"].as_array().unwrap().len(), 1);
            assert_eq!(body["tools"][0]["name"], "emit_result");
            assert_eq!(
                body["messages"][0]["content"][0]["text"],
                "Extract the answer"
            );
            assert_eq!(body["messages"].as_array().unwrap().len(), 2);
            assert_eq!(body["messages"][1]["role"], "system");
            let instruction = body["messages"][1]["content"].as_str().unwrap();
            assert!(instruction.contains("must begin with"));
            if choice["type"] == "tool" {
                assert!(instruction.contains("emit_result"));
            }
        }
        assert_eq!(tools, original_tools);
    }
    assert_eq!(
        messages,
        vec![json!({"role": "user", "content": "Extract the answer"})]
    );
}

#[test]
fn auto_and_none_choices_do_not_inject_instructions() {
    let client = client(AnthropicAuthMode::ApiKey, HashMap::new());
    for choice in [json!({"type": "auto"}), json!({"type": "none"})] {
        let tools = tools_with_choice(choice.clone());
        let (body, _) = serialized_request(
            &client,
            "claude-fable-5-1",
            &[json!({"role": "user", "content": "hello"})],
            Some(&tools),
            false,
        );
        assert_eq!(body["tool_choice"], choice);
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn custom_beta_headers_cannot_disable_binding_controls_or_duplicate_headers() {
    for auth in [
        AnthropicAuthMode::ApiKey,
        AnthropicAuthMode::AzureBearer,
        AnthropicAuthMode::ClaudeOauth,
    ] {
        for custom in [
            "custom-beta",
            "custom-beta, thinking-binding-controls-2026-08-01",
        ] {
            let client = client(
                auth,
                HashMap::from([
                    ("Anthropic-Beta".into(), custom.into()),
                    ("anthropic-beta".into(), "second-beta".into()),
                    ("x-custom".into(), "preserved".into()),
                ]),
            );
            let (_, headers) = serialized_request(&client, "claude-fable-5-1", &[], None, false);
            assert_eq!(headers.get_all("anthropic-beta").iter().count(), 1);
            let betas: Vec<_> = headers["anthropic-beta"]
                .to_str()
                .unwrap()
                .split(',')
                .collect();
            assert_eq!(
                betas
                    .iter()
                    .filter(|&&v| v == THINKING_BINDING_BETA)
                    .count(),
                1
            );
            assert!(betas.contains(&"custom-beta"));
            assert!(betas.contains(&"second-beta"));
            assert_eq!(headers["x-custom"], "preserved");
        }
    }
}

#[test]
fn changed_prefix_keeps_signed_blocks_for_provider_binding_validation() {
    let client = client(AnthropicAuthMode::ApiKey, HashMap::new());
    let messages = vec![
        json!({"role": "system", "content": "Updated system prompt or compacted summary"}),
        json!({"role": "user", "content": "Original request"}),
        json!({"role": "assistant", "content": null, "tool_calls": [{
            "id": "call_1", "type": "function",
            "function": {"name": "emit_result", "arguments": "{}"},
            "extra_content": {"anthropic": {"thinking": "", "signature": "opaque-signature"}}
        }]}),
        json!({"role": "tool", "tool_call_id": "call_1", "content": "Done"}),
    ];
    let original = messages.clone();
    let (body, headers) = serialized_request(
        &client,
        "claude-fable-5-1",
        &messages,
        Some(&[tool()]),
        true,
    );
    assert_eq!(
        body["messages"][1]["content"][0],
        json!({"type": "thinking", "thinking": "", "signature": "opaque-signature"})
    );
    assert_eq!(body["messages"][1]["content"][1]["type"], "tool_use");
    assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
    assert_eq!(
        body["thinking"]["block_binding"]["prefix_mismatch_behavior"],
        "drop_block"
    );
    assert!(headers["anthropic-beta"]
        .to_str()
        .unwrap()
        .contains(THINKING_BINDING_BETA));
    assert_eq!(messages, original);
}

#[test]
fn other_models_keep_their_request_contract() {
    let client = client(AnthropicAuthMode::ApiKey, HashMap::new());
    let tools = tools_with_choice(json!({"type": "tool", "name": "emit_result"}));
    let (body, headers) = serialized_request(
        &client,
        "claude-fable-5-ultracode",
        &[],
        Some(&tools),
        false,
    );
    assert_eq!(body["output_config"]["effort"], "ultracode");
    assert_eq!(body["tool_choice"]["type"], "tool");
    assert!(body.get("thinking").is_none());
    assert!(!headers["anthropic-beta"]
        .to_str()
        .unwrap()
        .contains(THINKING_BINDING_BETA));

    for model in ["claude-fable-5-10", "claude-opus-4-8", "claude-haiku-4-5"] {
        let (body, headers) = serialized_request(&client, model, &[], Some(&tools), false);
        assert_eq!(body["tool_choice"]["type"], "tool");
        assert!(body["thinking"].get("block_binding").is_none());
        assert!(!headers["anthropic-beta"]
            .to_str()
            .unwrap()
            .contains(THINKING_BINDING_BETA));
    }
}

#[test]
fn qualified_and_snapshot_ids_receive_fable_51_compatibility() {
    let client = client(AnthropicAuthMode::ApiKey, HashMap::new());
    for model in [
        "anthropic/claude-fable-5-1-high",
        "claude-fable-5-1-20260901-high",
        "anthropic.claude-fable-5-1-v1:0",
    ] {
        let (body, _) = serialized_request(&client, model, &[], None, false);
        assert_eq!(
            body["thinking"]["block_binding"]["prefix_mismatch_behavior"], "drop_block",
            "{model}"
        );
    }
}
