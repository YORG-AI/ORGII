//! A bounded tool round trip followed by streaming; no workspace content or tools run.
use key_vault::harness_connections::{HarnessProtocol, ResolvedHarnessConnection};
use serde_json::{json, Value};

const MAX_BYTES: usize = 256 * 1024;

async fn read_bounded(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!(
            "Endpoint returned HTTP {}. Check the key, endpoint and model.",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Connection response could not be read")?
    {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("Connection test response exceeded its size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn request(
    client: &reqwest::Client,
    connection: &ResolvedHarnessConnection,
    body: &Value,
) -> Result<reqwest::RequestBuilder, String> {
    let suffix = match connection.protocol {
        HarnessProtocol::AnthropicMessages => "/v1/messages",
        HarnessProtocol::OpenaiResponses => "/responses",
    };
    let url = format!("{}{suffix}", connection.base_url);
    let request = client.post(url).json(body);
    let request = if connection.protocol == HarnessProtocol::AnthropicMessages
        && connection.base_url == "https://api.anthropic.com"
    {
        request.header("x-api-key", &connection.api_key)
    } else {
        request.bearer_auth(&connection.api_key)
    };
    Ok(
        if connection.protocol == HarnessProtocol::AnthropicMessages {
            request.header("anthropic-version", "2023-06-01")
        } else {
            request
        },
    )
}

pub(super) async fn test(connection: &ResolvedHarnessConnection) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(40))
        .build()
        .map_err(|_| "Cannot create connection test client")?;
    let schema = json!({"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false});
    let prompt = "Call orgii_connection_echo with value 'ok'. After receiving the tool result, reply with 'ok'.";
    let initial = match connection.protocol {
        HarnessProtocol::AnthropicMessages => {
            json!({"model":connection.model,"max_tokens":128,"stream":false,
            "messages":[{"role":"user","content":prompt}],
            "tools":[{"name":"orgii_connection_echo","description":"Connection test echo","input_schema":schema}],
            "tool_choice":{"type":"tool","name":"orgii_connection_echo"}})
        }
        HarnessProtocol::OpenaiResponses => {
            json!({"model":connection.model,"max_output_tokens":512,"stream":false,"store":false,
            "input":[{"role":"user","content":prompt}],
            "tools":[{"type":"function","name":"orgii_connection_echo","description":"Connection test echo","parameters":schema,"strict":true}],
            "tool_choice":{"type":"function","name":"orgii_connection_echo"}})
        }
    };
    let response = request(&client, connection, &initial)?
        .send()
        .await
        .map_err(|_| "Cannot reach connection endpoint")?;
    let bytes = read_bounded(response).await?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Endpoint did not return the required protocol JSON")?;
    let followup = followup_body(connection.protocol, &initial, &value)?;
    let response = request(&client, connection, &followup)?
        .send()
        .await
        .map_err(|_| "Streaming tool round trip could not connect")?;
    let bytes = read_bounded(response).await?;
    validate_stream(connection.protocol, &bytes)
}

fn followup_body(
    protocol: HarnessProtocol,
    initial: &Value,
    response: &Value,
) -> Result<Value, String> {
    let mut next = initial.clone();
    next["stream"] = json!(true);
    next.as_object_mut()
        .ok_or("Invalid test request")?
        .remove("tool_choice");
    let (array, kind, id_key) = match protocol {
        HarnessProtocol::AnthropicMessages => ("content", "tool_use", "id"),
        HarnessProtocol::OpenaiResponses => ("output", "function_call", "call_id"),
    };
    let content = response
        .get(array)
        .and_then(Value::as_array)
        .ok_or("Endpoint lacks the required tool-call response")?;
    let tool = content
        .iter()
        .find(|value| value["type"] == kind && value["name"] == "orgii_connection_echo")
        .ok_or("Endpoint did not support the required function call")?;
    let id = tool[id_key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("Tool response has no call identifier")?;
    let arguments = if protocol == HarnessProtocol::AnthropicMessages {
        tool["input"].clone()
    } else {
        serde_json::from_str(
            tool["arguments"]
                .as_str()
                .ok_or("Invalid function arguments")?,
        )
        .map_err(|_| "Invalid function arguments")?
    };
    if arguments["value"] != "ok" {
        return Err("Endpoint did not preserve function arguments".into());
    }
    if protocol == HarnessProtocol::AnthropicMessages {
        next["messages"].as_array_mut().ok_or("Missing test messages")?.extend([
            json!({"role":"assistant","content":content}),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"ok"}]}),
        ]);
    } else {
        let input = next["input"].as_array_mut().ok_or("Missing test input")?;
        input.extend(content.clone());
        input.push(json!({"type":"function_call_output","call_id":id,"output":"ok"}));
    }
    Ok(next)
}

fn validate_stream(protocol: HarnessProtocol, bytes: &[u8]) -> Result<(), String> {
    let raw = std::str::from_utf8(bytes).map_err(|_| "Invalid streaming encoding")?;
    let mut text = false;
    let mut complete = false;
    for line in raw
        .lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim))
    {
        if line == "[DONE]" {
            continue;
        }
        let value: Value = serde_json::from_str(line).map_err(|_| "Invalid event stream")?;
        let event = value["type"].as_str().unwrap_or("");
        if matches!(event, "error" | "response.failed" | "response.incomplete") {
            return Err("Endpoint failed during streaming".into());
        }
        match protocol {
            HarnessProtocol::AnthropicMessages => {
                text |= event == "content_block_delta"
                    && value["delta"]["type"] == "text_delta"
                    && value["delta"]["text"]
                        .as_str()
                        .is_some_and(|text| !text.is_empty());
                complete |= event == "message_stop";
            }
            HarnessProtocol::OpenaiResponses => {
                text |= event == "response.output_text.delta"
                    && value["delta"].as_str().is_some_and(|text| !text.is_empty());
                complete |=
                    event == "response.completed" && value["response"]["status"] == "completed";
            }
        }
    }
    if text && complete {
        Ok(())
    } else {
        Err("Endpoint did not complete the required streaming tool round trip".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chat_completions_and_incomplete_streams_do_not_prove_responses() {
        let initial = json!({"input":[],"stream":false});
        assert!(followup_body(
            HarnessProtocol::OpenaiResponses,
            &initial,
            &json!({"choices":[]})
        )
        .is_err());
        assert!(validate_stream(HarnessProtocol::OpenaiResponses, b"data: [DONE]\n").is_err());
        assert!(validate_stream(
            HarnessProtocol::OpenaiResponses,
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n"
        )
        .is_err());
    }
    #[test]
    fn both_protocols_require_text_and_terminal_event() {
        for (protocol, events) in [
            (
                HarnessProtocol::OpenaiResponses,
                vec![
                    json!({"type":"response.output_text.delta","delta":"ok"}),
                    json!({"type":"response.completed","response":{"status":"completed"}}),
                ],
            ),
            (
                HarnessProtocol::AnthropicMessages,
                vec![
                    json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}),
                    json!({"type":"message_stop"}),
                ],
            ),
        ] {
            let raw = events
                .iter()
                .map(|event| format!("data: {event}\n\n"))
                .collect::<String>();
            validate_stream(protocol, raw.as_bytes()).unwrap();
        }
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
    use std::sync::{Arc, Mutex};

    type Requests = Arc<Mutex<Vec<Value>>>;
    async fn respond(
        State(requests): State<Requests>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> (HeaderMap, String) {
        assert_eq!(headers["authorization"], "Bearer synthetic-fixture-key");
        assert_eq!(body["model"], "fixture-model");
        requests.lock().unwrap().push(body.clone());
        let anthropic = body.get("messages").is_some();
        let mut headers = HeaderMap::new();
        if body["stream"] == true {
            headers.insert("content-type", "text/event-stream".parse().unwrap());
            let events = if anthropic {
                vec![
                    json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}),
                    json!({"type":"message_stop"}),
                ]
            } else {
                vec![
                    json!({"type":"response.output_text.delta","delta":"ok"}),
                    json!({"type":"response.completed","response":{"status":"completed"}}),
                ]
            };
            (
                headers,
                events
                    .iter()
                    .map(|event| format!("data: {event}\n\n"))
                    .collect(),
            )
        } else {
            headers.insert("content-type", "application/json".parse().unwrap());
            let response = if anthropic {
                json!({"content":[{"type":"tool_use","id":"call_fixture","name":"orgii_connection_echo","input":{"value":"ok"}}]})
            } else {
                json!({"output":[{"type":"function_call","call_id":"call_fixture","name":"orgii_connection_echo","arguments":"{\"value\":\"ok\"}"}]})
            };
            (headers, response.to_string())
        }
    }

    #[tokio::test]
    async fn both_protocols_send_a_tool_result_and_consume_a_completed_stream() {
        crate::test_utils::install_crypto_provider_for_tests();
        for protocol in [
            HarnessProtocol::OpenaiResponses,
            HarnessProtocol::AnthropicMessages,
        ] {
            let requests = Requests::default();
            let router = Router::new()
                .route("/responses", post(respond))
                .route("/v1/messages", post(respond))
                .with_state(requests.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            let connection = ResolvedHarnessConnection {
                key_id: "fixture".into(),
                provider: "custom_api".into(),
                model: "fixture-model".into(),
                base_url: format!("http://{addr}"),
                api_key: "synthetic-fixture-key".into(),
                protocol,
                requires_test: true,
                revision: "fixture".into(),
            };
            let result = test(&connection).await;
            server.abort();
            let _ = server.await;
            result.unwrap();
            let requests = requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            if protocol == HarnessProtocol::AnthropicMessages {
                assert_eq!(
                    requests[1]["messages"][2]["content"][0]["tool_use_id"],
                    "call_fixture"
                );
            } else {
                assert_eq!(requests[1]["input"][2]["call_id"], "call_fixture");
            }
        }
    }
}
