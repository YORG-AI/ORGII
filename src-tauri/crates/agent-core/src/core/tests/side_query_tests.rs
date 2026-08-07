use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::core::side_query::{
    extract_tool_choice_override, side_query, SideQueryConfig, StructuredOutput,
    TOOL_CHOICE_OVERRIDE_KEY,
};
use crate::providers::traits::{
    finish_reason, LLMProvider, LLMResponse, ProviderError, ToolCallRequest,
};

// ── Mock infrastructure ──

struct MockProvider {
    response_content: String,
    reasoning_content: Option<String>,
    tool_calls: Vec<ToolCallRequest>,
    finish_reason: String,
    usage: HashMap<String, i64>,
    observed_messages: Mutex<Vec<Value>>,
    observed_tools_were_none: Mutex<bool>,
    observed_tools: Mutex<Option<Vec<Value>>>,
    call_count: Mutex<u32>,
}

impl MockProvider {
    fn new(content: &str) -> Self {
        let mut usage = HashMap::new();
        usage.insert("prompt_tokens".to_string(), 100);
        usage.insert("completion_tokens".to_string(), 50);
        Self {
            response_content: content.to_string(),
            reasoning_content: None,
            tool_calls: vec![],
            finish_reason: finish_reason::STOP.to_string(),
            usage,
            observed_messages: Mutex::new(Vec::new()),
            observed_tools_were_none: Mutex::new(false),
            observed_tools: Mutex::new(None),
            call_count: Mutex::new(0),
        }
    }

    fn empty() -> Self {
        Self {
            response_content: String::new(),
            reasoning_content: None,
            tool_calls: vec![],
            finish_reason: finish_reason::STOP.to_string(),
            usage: HashMap::new(),
            observed_messages: Mutex::new(Vec::new()),
            observed_tools_were_none: Mutex::new(false),
            observed_tools: Mutex::new(None),
            call_count: Mutex::new(0),
        }
    }

    fn thinking_only(reasoning: &str) -> Self {
        Self {
            response_content: String::new(),
            reasoning_content: Some(reasoning.to_string()),
            tool_calls: vec![],
            finish_reason: finish_reason::STOP.to_string(),
            usage: {
                let mut u = HashMap::new();
                u.insert("prompt_tokens".to_string(), 200);
                u.insert("completion_tokens".to_string(), 150);
                u
            },
            observed_messages: Mutex::new(Vec::new()),
            observed_tools_were_none: Mutex::new(false),
            observed_tools: Mutex::new(None),
            call_count: Mutex::new(0),
        }
    }

    fn with_tool_call(tool_name: &str, arguments: Value) -> Self {
        Self {
            response_content: String::new(),
            reasoning_content: None,
            tool_calls: vec![ToolCallRequest {
                id: "call_1".to_string(),
                name: tool_name.to_string(),
                arguments,
                thought_signature: None,
            }],
            finish_reason: finish_reason::STOP.to_string(),
            usage: {
                let mut u = HashMap::new();
                u.insert("prompt_tokens".to_string(), 200);
                u.insert("completion_tokens".to_string(), 100);
                u
            },
            observed_messages: Mutex::new(Vec::new()),
            observed_tools_were_none: Mutex::new(false),
            observed_tools: Mutex::new(None),
            call_count: Mutex::new(0),
        }
    }

    fn with_tool_call_finish(tool_name: &str, arguments: Value, finish: &str) -> Self {
        let mut provider = Self::with_tool_call(tool_name, arguments);
        provider.finish_reason = finish.to_string();
        provider
    }
}

#[async_trait]
impl LLMProvider for MockProvider {
    async fn chat(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        *self.observed_messages.lock().unwrap() = messages.to_vec();
        *self.observed_tools_were_none.lock().unwrap() = tools.is_none();
        *self.observed_tools.lock().unwrap() = tools.map(|t| t.to_vec());
        *self.call_count.lock().unwrap() += 1;

        Ok(LLMResponse {
            content: if self.response_content.is_empty() {
                None
            } else {
                Some(self.response_content.clone())
            },
            tool_calls: self.tool_calls.clone(),
            finish_reason: self.finish_reason.clone(),
            usage: self.usage.clone(),
            reasoning_content: self.reasoning_content.clone(),
            blocks: Vec::new(),
            stream_error_kind: None,
            retry_after_ms: None,
        })
    }

    fn default_model(&self) -> &str {
        "mock-model"
    }

    fn provider_name(&self) -> &str {
        "mock"
    }
}

// ── Basic side query (unchanged behavior) ──

#[tokio::test]
async fn returns_content_from_provider() {
    let provider = MockProvider::new("Classification: bug-fix");
    let messages = vec![json!({"role": "user", "content": "Classify this PR"})];
    let config = SideQueryConfig::default();

    let result = side_query(&provider, &messages, &config, "test-model")
        .await
        .unwrap();

    assert_eq!(result.content, "Classification: bug-fix");
    assert_eq!(result.prompt_tokens, 100);
    assert_eq!(result.completion_tokens, 50);
    assert!(result.structured.is_none());
}

#[tokio::test]
async fn stream_error_with_partial_structured_output_is_not_accepted() {
    let provider = MockProvider::with_tool_call_finish(
        "emit_summary",
        json!({"summary": "partial output"}),
        finish_reason::STREAM_ERROR,
    );
    let config = SideQueryConfig {
        structured: Some(StructuredOutput {
            tool_name: "emit_summary".to_string(),
            schema: json!({"type": "object"}),
        }),
        ..SideQueryConfig::default()
    };

    let err = side_query(&provider, &[], &config, "test-model")
        .await
        .expect_err("partial streamed tool arguments must not be durable output");

    assert!(err.contains("incomplete output: finish_reason=stream_error"));
    assert_eq!(*provider.call_count.lock().unwrap(), 2);
}

#[tokio::test]
async fn applies_default_config_values() {
    let config = SideQueryConfig::default();
    assert_eq!(config.max_tokens, 1024);
    assert_eq!(config.temperature, 0.0);
    assert!(config.model.is_none());
    assert!(config.system_prompt.is_none());
    assert!(config.structured.is_none());
    assert!(config.account_id.is_none());
}

#[tokio::test]
async fn uses_custom_model_when_set() {
    let provider = MockProvider::new("ok");
    let messages = vec![json!({"role": "user", "content": "test"})];
    let config = SideQueryConfig {
        model: Some("custom-haiku".to_string()),
        ..SideQueryConfig::default()
    };

    let result = side_query(&provider, &messages, &config, "default-model").await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn includes_system_prompt_when_set() {
    let provider = MockProvider::new("summarized");
    let messages = vec![json!({"role": "user", "content": "Summarize this"})];
    let config = SideQueryConfig {
        system_prompt: Some("You are a summarizer".to_string()),
        ..SideQueryConfig::default()
    };

    let result = side_query(&provider, &messages, &config, "test-model")
        .await
        .unwrap();
    assert_eq!(result.content, "summarized");
}

#[tokio::test]
async fn sends_only_explicit_side_query_prompt_and_no_tools() {
    let provider = MockProvider::new("ok");
    let messages = vec![json!({"role": "user", "content": "Classify this"})];
    let config = SideQueryConfig {
        system_prompt: Some("Short classifier prompt".to_string()),
        ..SideQueryConfig::default()
    };

    side_query(&provider, &messages, &config, "test-model")
        .await
        .unwrap();

    let observed = provider.observed_messages.lock().unwrap().clone();
    assert_eq!(observed.len(), 2);
    assert_eq!(observed[0]["role"], "system");
    assert_eq!(observed[0]["content"], "Short classifier prompt");
    assert_eq!(observed[1]["content"], "Classify this");
    assert!(*provider.observed_tools_were_none.lock().unwrap());
    let serialized = serde_json::to_string(&observed).unwrap();
    assert!(!serialized.contains("IdentitySection"));
    assert!(!serialized.contains("You are ORGII"));
    assert!(!serialized.contains("read_file"));
}

#[tokio::test]
async fn handles_zero_usage_gracefully() {
    let mut provider = MockProvider::new("ok");
    provider.usage.clear();
    let messages = vec![json!({"role": "user", "content": "test"})];
    let config = SideQueryConfig::default();

    let result = side_query(&provider, &messages, &config, "test-model")
        .await
        .unwrap();
    assert_eq!(result.prompt_tokens, 0);
    assert_eq!(result.completion_tokens, 0);
}

// ── primary_text() fallback: thinking-only responses ──

#[tokio::test]
async fn thinking_only_response_falls_back_to_reasoning_content() {
    let provider = MockProvider::thinking_only("The answer after deep reasoning is: yes");
    let messages = vec![json!({"role": "user", "content": "test"})];
    let config = SideQueryConfig::default();

    let result = side_query(&provider, &messages, &config, "test-model")
        .await
        .unwrap();

    assert_eq!(result.content, "The answer after deep reasoning is: yes");
}

#[tokio::test]
async fn truly_empty_response_returns_error() {
    let provider = MockProvider::empty();
    let messages = vec![json!({"role": "user", "content": "test"})];
    let config = SideQueryConfig::default();

    let result = side_query(&provider, &messages, &config, "test-model").await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("empty content"));
}

// ── Structured output (forced tool call) ──

#[tokio::test]
async fn structured_output_extracts_from_tool_call() {
    let provider = MockProvider::with_tool_call(
        "emit_summary",
        json!({"summary": "Files were changed, tests passed"}),
    );
    let messages = vec![json!({"role": "user", "content": "Summarize"})];
    let config = SideQueryConfig {
        structured: Some(StructuredOutput {
            tool_name: "emit_summary".to_string(),
            schema: json!({
                "type": "object",
                "properties": { "summary": { "type": "string" } },
                "required": ["summary"]
            }),
        }),
        ..SideQueryConfig::default()
    };

    let result = side_query(&provider, &messages, &config, "test-model")
        .await
        .unwrap();

    assert!(result.structured.is_some());
    let structured = result.structured.unwrap();
    assert_eq!(structured["summary"], "Files were changed, tests passed");
}

// ── Empty forced-tool-call arguments (live bug: compaction summarizer
//     answered a 233K-token prompt with an empty emit_summary `{}`) ──

#[test]
fn structured_arguments_are_empty_detects_useless_payloads() {
    use super::structured_arguments_are_empty;

    // Empty shapes → true
    assert!(structured_arguments_are_empty(&json!(null)));
    assert!(structured_arguments_are_empty(&json!({})));
    assert!(structured_arguments_are_empty(&json!({"summary": ""})));
    assert!(structured_arguments_are_empty(&json!({"summary": "  \n"})));
    assert!(structured_arguments_are_empty(
        &json!({"summary": null, "notes": ""})
    ));

    // Usable payloads → false
    assert!(!structured_arguments_are_empty(
        &json!({"summary": "real content"})
    ));
    assert!(!structured_arguments_are_empty(
        &json!({"count": 0, "summary": ""})
    ));
    // Non-object shapes are the caller's schema problem, not "empty"
    assert!(!structured_arguments_are_empty(&json!("bare string")));
    assert!(!structured_arguments_are_empty(&json!([1, 2])));
}

/// First call answers the forced tool call with `{}`; the retry (which
/// drops the tool_choice override) answers with a real tool call. The
/// empty first response must NOT be accepted as structured output.
struct EmptyThenGoodProvider {
    call_count: Mutex<u32>,
}

#[async_trait]
impl LLMProvider for EmptyThenGoodProvider {
    async fn chat(
        &self,
        _messages: &[Value],
        _tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        let mut count = self.call_count.lock().unwrap();
        *count += 1;
        let arguments = if *count == 1 {
            json!({})
        } else {
            json!({"summary": "recovered on retry"})
        };
        Ok(LLMResponse {
            content: None,
            tool_calls: vec![ToolCallRequest {
                id: format!("call_{count}"),
                name: "emit_summary".to_string(),
                arguments,
                thought_signature: None,
            }],
            finish_reason: crate::providers::finish_reason::STOP.to_string(),
            usage: HashMap::new(),
            reasoning_content: None,
            blocks: Vec::new(),
            stream_error_kind: None,
            retry_after_ms: None,
        })
    }

    fn default_model(&self) -> &str {
        "mock-model"
    }

    fn provider_name(&self) -> &str {
        "mock"
    }
}

#[tokio::test]
async fn empty_structured_arguments_trigger_retry_instead_of_success() {
    let provider = EmptyThenGoodProvider {
        call_count: Mutex::new(0),
    };
    let messages = vec![json!({"role": "user", "content": "Summarize"})];
    let config = SideQueryConfig {
        structured: Some(StructuredOutput {
            tool_name: "emit_summary".to_string(),
            schema: json!({
                "type": "object",
                "properties": { "summary": { "type": "string" } },
                "required": ["summary"]
            }),
        }),
        ..SideQueryConfig::default()
    };

    let result = side_query(&provider, &messages, &config, "test-model")
        .await
        .unwrap();

    assert_eq!(*provider.call_count.lock().unwrap(), 2);
    let structured = result.structured.expect("retry should recover");
    assert_eq!(structured["summary"], "recovered on retry");
}

/// Both attempts return empty arguments and no text at all → hard error,
/// never an empty structured "success" (the caller would persist a blank
/// summary over real history).
struct AlwaysEmptyStructuredProvider;

#[async_trait]
impl LLMProvider for AlwaysEmptyStructuredProvider {
    async fn chat(
        &self,
        _messages: &[Value],
        _tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        Ok(LLMResponse {
            content: None,
            tool_calls: vec![ToolCallRequest {
                id: "call_1".to_string(),
                name: "emit_summary".to_string(),
                arguments: json!({"summary": ""}),
                thought_signature: None,
            }],
            finish_reason: crate::providers::finish_reason::STOP.to_string(),
            usage: HashMap::new(),
            reasoning_content: None,
            blocks: Vec::new(),
            stream_error_kind: None,
            retry_after_ms: None,
        })
    }

    fn default_model(&self) -> &str {
        "mock-model"
    }

    fn provider_name(&self) -> &str {
        "mock"
    }
}

#[tokio::test]
async fn persistently_empty_structured_arguments_return_error() {
    let provider = AlwaysEmptyStructuredProvider;
    let messages = vec![json!({"role": "user", "content": "Summarize"})];
    let config = SideQueryConfig {
        structured: Some(StructuredOutput {
            tool_name: "emit_summary".to_string(),
            schema: json!({
                "type": "object",
                "properties": { "summary": { "type": "string" } },
                "required": ["summary"]
            }),
        }),
        ..SideQueryConfig::default()
    };

    let result = side_query(&provider, &messages, &config, "test-model").await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("empty content"));
}

#[tokio::test]
async fn structured_output_length_finish_is_rejected_even_when_parseable() {
    let provider = MockProvider::with_tool_call_finish(
        "emit_summary",
        json!({"summary": "partial but parseable"}),
        finish_reason::LENGTH,
    );
    let messages = vec![json!({"role": "user", "content": "Summarize"})];
    let config = SideQueryConfig {
        structured: Some(StructuredOutput {
            tool_name: "emit_summary".to_string(),
            schema: json!({
                "type": "object",
                "properties": { "summary": { "type": "string" } },
                "required": ["summary"]
            }),
        }),
        ..SideQueryConfig::default()
    };

    let err = side_query(&provider, &messages, &config, "test-model")
        .await
        .expect_err("length-truncated structured output must not be accepted");

    assert!(err.contains("incomplete output"), "unexpected error: {err}");
    assert_eq!(
        *provider.call_count.lock().unwrap(),
        2,
        "should retry once before hard fail"
    );
}

#[tokio::test]
async fn structured_output_sends_tool_with_choice_override() {
    let provider = MockProvider::with_tool_call("emit_summary", json!({"summary": "ok"}));
    let messages = vec![json!({"role": "user", "content": "Summarize"})];
    let config = SideQueryConfig {
        structured: Some(StructuredOutput {
            tool_name: "emit_summary".to_string(),
            schema: json!({
                "type": "object",
                "properties": { "summary": { "type": "string" } },
                "required": ["summary"]
            }),
        }),
        ..SideQueryConfig::default()
    };

    side_query(&provider, &messages, &config, "test-model")
        .await
        .unwrap();

    // Verify tools were sent (not None)
    assert!(!*provider.observed_tools_were_none.lock().unwrap());
    let tools = provider.observed_tools.lock().unwrap().clone().unwrap();
    // Should have the tool definition + tool_choice override sentinel
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0]["function"]["name"], "emit_summary");
    assert!(tools[1].get(TOOL_CHOICE_OVERRIDE_KEY).is_some());
}

// ── Tool choice override extraction ──

#[test]
fn extract_tool_choice_override_strips_sentinel() {
    let tools = vec![
        json!({"type": "function", "function": {"name": "my_tool"}}),
        json!({TOOL_CHOICE_OVERRIDE_KEY: {"type": "tool", "name": "my_tool"}}),
    ];

    let (override_val, cleaned) = extract_tool_choice_override(&tools);

    assert!(override_val.is_some());
    assert_eq!(override_val.unwrap()["name"], "my_tool");
    assert_eq!(cleaned.len(), 1);
    assert_eq!(cleaned[0]["function"]["name"], "my_tool");
}

#[test]
fn extract_tool_choice_override_returns_none_when_no_sentinel() {
    let tools = vec![json!({"type": "function", "function": {"name": "read_file"}})];

    let (override_val, cleaned) = extract_tool_choice_override(&tools);

    assert!(override_val.is_none());
    assert_eq!(cleaned.len(), 1);
}

// ── LLMResponse::primary_text() ──

#[test]
fn primary_text_prefers_content() {
    let resp = LLMResponse {
        content: Some("visible answer".to_string()),
        reasoning_content: Some("internal reasoning".to_string()),
        tool_calls: vec![],
        finish_reason: "stop".to_string(),
        usage: HashMap::new(),
        blocks: vec![],
        stream_error_kind: None,
        retry_after_ms: None,
    };
    assert_eq!(resp.primary_text(), Some("visible answer"));
}

#[test]
fn primary_text_falls_back_to_reasoning() {
    let resp = LLMResponse {
        content: None,
        reasoning_content: Some("thinking-only answer".to_string()),
        tool_calls: vec![],
        finish_reason: "stop".to_string(),
        usage: HashMap::new(),
        blocks: vec![],
        stream_error_kind: None,
        retry_after_ms: None,
    };
    assert_eq!(resp.primary_text(), Some("thinking-only answer"));
}

#[test]
fn primary_text_returns_none_when_both_empty() {
    let resp = LLMResponse {
        content: Some("  ".to_string()),
        reasoning_content: Some("".to_string()),
        tool_calls: vec![],
        finish_reason: "stop".to_string(),
        usage: HashMap::new(),
        blocks: vec![],
        stream_error_kind: None,
        retry_after_ms: None,
    };
    assert_eq!(resp.primary_text(), None);
}

#[test]
fn primary_text_skips_whitespace_only_content() {
    let resp = LLMResponse {
        content: Some("\n  \t ".to_string()),
        reasoning_content: Some("real answer in reasoning".to_string()),
        tool_calls: vec![],
        finish_reason: "stop".to_string(),
        usage: HashMap::new(),
        blocks: vec![],
        stream_error_kind: None,
        retry_after_ms: None,
    };
    assert_eq!(resp.primary_text(), Some("real answer in reasoning"));
}
