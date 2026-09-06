//! Persisted custom catalog IDs must reach both provider protocols unchanged.
use crate::providers::anthropic_native::AnthropicClient;
use crate::providers::openai_compat::OpenAICompatClient;
use crate::providers::registry::{find_by_name, provider_id};
use crate::providers::traits::{LLMProvider, ProviderConfig};
use key_vault::key_store::{KeyService, ModelAlias, ModelKey, ModelType};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn assert_request(anthropic: bool, stream: bool, model: &str) {
    crate::test_support::install_crypto_provider_for_tests();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/custom/v1", listener.local_addr().unwrap());
    let model = model.to_string();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let (header_end, length) = loop {
            let mut buffer = [0; 4096];
            let n = socket.read(&mut buffer).await.unwrap();
            assert!(n > 0 && bytes.len() + n < 131_072);
            bytes.extend_from_slice(&buffer[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                let length: usize = headers
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                break (end + 4, length);
            }
        };
        while bytes.len() < header_end + length {
            let mut buffer = [0; 4096];
            let n = socket.read(&mut buffer).await.unwrap();
            assert!(n > 0 && bytes.len() + n < 131_072);
            bytes.extend_from_slice(&buffer[..n]);
        }
        let headers = String::from_utf8_lossy(&bytes[..header_end]).to_lowercase();
        let body: Value = serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
        let response = match (anthropic, stream) {
            (false, false) => json!({"id":"fixture","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}).to_string(),
            (true, false) => json!({"id":"fixture","type":"message","role":"assistant","model":"fixture","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}).to_string(),
            (false, true) => "data: {\"id\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".into(),
            (true, true) => [
                ("message_start", json!({"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","model":"fixture","content":[],"usage":{"input_tokens":1,"output_tokens":0}}})),
                ("content_block_start", json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})),
                ("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}})),
                ("content_block_stop", json!({"type":"content_block_stop","index":0})),
                ("message_delta", json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}})),
                ("message_stop", json!({"type":"message_stop"})),
            ].into_iter().map(|(event, data)| format!("event: {event}\ndata: {data}\n\n")).collect(),
        };
        let content_type = if stream {
            "text/event-stream"
        } else {
            "application/json"
        };
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
        (headers, body)
    });

    let dir = tempfile::tempdir().unwrap();
    let service = KeyService::new(Some(dir.path().into()));
    let mut key = ModelKey::new(ModelType::CustomApi);
    key.api_key = Some("fixture-key".into());
    key.base_url = Some(endpoint);
    key.enabled_models = vec![model.clone()];
    key.model_aliases = vec![ModelAlias {
        alias: model.clone(),
        display_name: "Display name is never a request model".into(),
        icon: None,
    }];
    let saved = service.save_key(key).unwrap();
    let key = KeyService::new(Some(dir.path().into()))
        .get_key_by_id(&saved.id)
        .unwrap();
    let config = ProviderConfig {
        api_key: key.api_key.unwrap(),
        api_base: key.base_url,
        extra_headers: Default::default(),
        is_azure: false,
    };
    let spec = find_by_name(provider_id::CUSTOM).unwrap();
    let client: Box<dyn LLMProvider> = if anthropic {
        Box::new(AnthropicClient::new(config, spec, model.clone()))
    } else {
        Box::new(OpenAICompatClient::new(config, spec, model.clone()))
    };
    let messages = [json!({"role":"user","content":"hello"})];
    let response = if stream {
        client
            .chat_streaming(&messages, None, &model, 16, 0.1, &|_| {}, None)
            .await
    } else {
        client.chat(&messages, None, &model, 16, 0.1).await
    };
    assert!(response.is_ok(), "{response:?}");
    let (headers, body) = server.await.unwrap();
    let path = if anthropic {
        "/custom/v1/messages"
    } else {
        "/custom/v1/chat/completions"
    };
    assert!(
        headers.starts_with(&format!("post {path} http/1.1")),
        "{headers}"
    );
    assert!(headers.contains(if anthropic {
        "x-api-key: fixture-key"
    } else {
        "authorization: bearer fixture-key"
    }));
    assert_eq!(body["model"], model);
    assert_eq!(body["stream"].as_bool().unwrap_or(false), stream);
    assert!(body.get("reasoning_effort").is_none());
}

#[tokio::test]
async fn custom_model_ids_reach_both_protocols_in_streaming_and_chat() {
    tokio::time::timeout(Duration::from_secs(15), async {
        for anthropic in [false, true] {
            for stream in [false, true] {
                for model in [
                    "deployment-high",
                    "sonnet-special",
                    "new-provider/model-2026-09-01",
                ] {
                    assert_request(anthropic, stream, model).await;
                }
            }
        }
    })
    .await
    .expect("custom model request fixture timed out");
}
