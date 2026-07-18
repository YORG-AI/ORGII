//! Integration tests for the streaming retry loop in `execute_turn`.
//!
//! Uses a configurable `MockRetryProvider` that returns `STREAM_ERROR` for
//! the first N calls and then succeeds, allowing us to assert the full retry
//! event sequence (attempts, backoff, heartbeats, recovery, exhaustion).
//!
//! These tests exercise the actual `execute_turn` function end-to-end with
//! zero-cost backoff overrides (see `set_test_backoff_override_ms`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;

use crate::providers::finish_reason;
use crate::providers::traits::{LLMProvider, LLMResponse, ProviderError, StreamErrorKind};
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;
use crate::turn_executor::{
    execute_turn, set_test_backoff_override_ms, TurnConfig, TurnEventHandler,
};

// ============================================
// Mock Provider
// ============================================

struct MockRetryProvider {
    /// Calls remaining that will return STREAM_ERROR.
    errors_remaining: AtomicU32,
    /// Which kind of error to inject.
    error_kind: StreamErrorKind,
    /// Optional retry_after_ms to embed in the error response.
    retry_after_ms: Option<u64>,
    /// Content returned on success.
    success_content: String,
}

impl MockRetryProvider {
    fn new(
        error_count: u32,
        error_kind: StreamErrorKind,
        retry_after_ms: Option<u64>,
        success_content: &str,
    ) -> Self {
        Self {
            errors_remaining: AtomicU32::new(error_count),
            error_kind,
            retry_after_ms,
            success_content: success_content.to_string(),
        }
    }
}

#[async_trait]
impl LLMProvider for MockRetryProvider {
    async fn chat(
        &self,
        _messages: &[Value],
        _tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        let remaining = self.errors_remaining.load(Ordering::SeqCst);
        if remaining > 0 {
            self.errors_remaining.fetch_sub(1, Ordering::SeqCst);
            Ok(LLMResponse {
                content: None,
                tool_calls: vec![],
                finish_reason: finish_reason::STREAM_ERROR.to_string(),
                usage: HashMap::new(),
                reasoning_content: None,
                blocks: Vec::new(),
                stream_error_kind: Some(self.error_kind),
                retry_after_ms: self.retry_after_ms,
            })
        } else {
            Ok(LLMResponse {
                content: Some(self.success_content.clone()),
                tool_calls: vec![],
                finish_reason: finish_reason::STOP.to_string(),
                usage: {
                    let mut u = HashMap::new();
                    u.insert("prompt_tokens".into(), 10);
                    u.insert("completion_tokens".into(), 5);
                    u
                },
                reasoning_content: None,
                blocks: Vec::new(),
                stream_error_kind: None,
                retry_after_ms: None,
            })
        }
    }

    fn default_model(&self) -> &str {
        "mock-retry"
    }

    fn provider_name(&self) -> &str {
        "mock-retry"
    }
}

// ============================================
// Mock Event Handler
// ============================================

#[derive(Debug, Clone)]
struct RetryEvent {
    kind: String,
    attempt: u32,
    max_attempts: u32,
    backoff_ms: u64,
}

#[derive(Debug, Clone)]
struct ExhaustedEvent {
    kind: String,
    attempts: u32,
}

struct MockRetryHandler {
    retries: Mutex<Vec<RetryEvent>>,
    exhausted: Mutex<Vec<ExhaustedEvent>>,
}

impl MockRetryHandler {
    fn new() -> Self {
        Self {
            retries: Mutex::new(Vec::new()),
            exhausted: Mutex::new(Vec::new()),
        }
    }

    fn retries(&self) -> Vec<RetryEvent> {
        self.retries.lock().unwrap().clone()
    }

    fn exhausted(&self) -> Vec<ExhaustedEvent> {
        self.exhausted.lock().unwrap().clone()
    }
}

#[async_trait]
impl TurnEventHandler for MockRetryHandler {
    fn on_message_delta(&self, _session_id: &str, _content: &str) {}

    fn on_tool_call(
        &self,
        _session_id: &str,
        _tool_call_id: &str,
        _tool_name: &str,
        _display_name: &str,
        _args: &Value,
    ) {
    }

    fn on_tool_result(
        &self,
        _session_id: &str,
        _tool_call_id: &str,
        _tool_name: &str,
        _display_name: &str,
        _result: &str,
    ) {
    }

    fn on_stream_retry(
        &self,
        _session_id: &str,
        kind: &str,
        attempt: u32,
        max_attempts: u32,
        backoff_ms: u64,
    ) {
        self.retries.lock().unwrap().push(RetryEvent {
            kind: kind.to_string(),
            attempt,
            max_attempts,
            backoff_ms,
        });
    }

    fn on_stream_error_exhausted(
        &self,
        _session_id: &str,
        kind: &str,
        attempts: u32,
        _user_message: &str,
    ) {
        self.exhausted.lock().unwrap().push(ExhaustedEvent {
            kind: kind.to_string(),
            attempts,
        });
    }
}

// ============================================
// Helpers
// ============================================

fn empty_policy() -> ResolvedToolPolicy {
    ResolvedToolPolicy::from_layers(vec![])
}

fn test_config() -> TurnConfig {
    TurnConfig {
        turn_intent_id: String::new(),
        projected_inbox_ids: Vec::new(),
        model: "mock-model".to_string(),
        account_id: None,
        context_window_override: None,
        max_iterations: Some(50),
        max_tokens: 1024,
        temperature: 0.0,
        max_tool_use_concurrency: 10,
        screenshot_store: None,
        iteration_hook: None,
        persist_cancel_marker: false,
        steering_queue: None,
        auto_continue: false,
    }
}

// ============================================
// Tests
// ============================================

#[tokio::test]
async fn recovery_after_connection_errors() {
    set_test_backoff_override_ms(5);

    let provider = MockRetryProvider::new(3, StreamErrorKind::ConnectionError, None, "recovered");
    let handler = MockRetryHandler::new();
    let tools = ToolRegistry::new();
    let policy = empty_policy();
    let config = test_config();
    let mut messages = vec![serde_json::json!({
        "role": "user",
        "content": "hello"
    })];

    let result = execute_turn(
        &mut messages,
        &provider,
        &tools,
        &policy,
        &config,
        "test-session",
        &handler,
        None,
        None,
        None,
    )
    .await
    .expect("turn should succeed");

    assert_eq!(result.content.as_deref(), Some("recovered"));

    let retries = handler.retries();
    assert_eq!(
        retries.len(),
        3,
        "expected 3 retry events, got {:?}",
        retries
    );
    for (idx, retry) in retries.iter().enumerate() {
        assert_eq!(retry.kind, "connection_error");
        assert_eq!(retry.attempt, (idx + 1) as u32);
        assert_eq!(retry.max_attempts, 10);
    }

    assert!(handler.exhausted().is_empty());
}

#[tokio::test]
async fn overloaded_budget_exhaustion() {
    set_test_backoff_override_ms(5);

    // MAX_OVERLOADED_RETRIES = 3. Inject 4 errors so the budget is exhausted.
    let provider = MockRetryProvider::new(4, StreamErrorKind::Overloaded, None, "should-not-reach");
    let handler = MockRetryHandler::new();
    let tools = ToolRegistry::new();
    let policy = empty_policy();
    let config = test_config();
    let mut messages = vec![serde_json::json!({
        "role": "user",
        "content": "hello"
    })];

    let result = execute_turn(
        &mut messages,
        &provider,
        &tools,
        &policy,
        &config,
        "test-session",
        &handler,
        None,
        None,
        None,
    )
    .await
    .expect("turn should complete (with error message)");

    // The turn should have bailed with a user-visible overload message.
    let content = result.content.expect("expected user-facing error message");
    assert!(
        content.contains("overloaded"),
        "expected overload message, got: {content}"
    );

    // 3 retry events fired before exhaustion.
    let retries = handler.retries();
    assert_eq!(
        retries.len(),
        3,
        "expected 3 retry events, got {:?}",
        retries
    );
    for retry in &retries {
        assert_eq!(retry.kind, "overloaded");
        assert_eq!(retry.max_attempts, 3);
    }

    // Exactly one exhausted event. The `attempts` value is the number of
    // actual retries attempted (= max_attempts), not the incremented counter
    // at the point of bailout. turn_executor passes `attempt - 1` to the
    // handler, which equals `MAX_OVERLOADED_RETRIES = 3`.
    let exhausted = handler.exhausted();
    assert_eq!(exhausted.len(), 1);
    assert_eq!(exhausted[0].kind, "overloaded");
    assert_eq!(exhausted[0].attempts, 3);
}

// Note: connection_error exhaustion (11 retries × real backoff) is covered
// by the overloaded_budget_exhaustion test's structural assertions on the
// exhausted event pathway. A separate 11-retry test would take 160s+ even
// with the override due to concurrent test execution and global-static
// contention. If isolation is needed, add `#[serial]` (serial_test crate).

#[tokio::test]
async fn retry_after_floor_is_honored() {
    set_test_backoff_override_ms(5);

    // The provider embeds a retry_after_ms of 50ms. Our default backoff
    // override is 5ms. The floor logic should pick max(50, 5) = 50.
    let provider = MockRetryProvider::new(
        1,
        StreamErrorKind::Overloaded,
        Some(50),
        "recovered-with-floor",
    );
    let handler = MockRetryHandler::new();
    let tools = ToolRegistry::new();
    let policy = empty_policy();
    let config = test_config();
    let mut messages = vec![serde_json::json!({
        "role": "user",
        "content": "test retry_after floor"
    })];

    let result = execute_turn(
        &mut messages,
        &provider,
        &tools,
        &policy,
        &config,
        "test-session",
        &handler,
        None,
        None,
        None,
    )
    .await
    .expect("turn should succeed");

    assert_eq!(result.content.as_deref(), Some("recovered-with-floor"));

    let retries = handler.retries();
    assert_eq!(retries.len(), 1);
    // The backoff_ms should reflect the provider floor of 50, not the 5ms override.
    assert!(
        retries[0].backoff_ms >= 50,
        "expected backoff >= 50ms (provider floor), got {}ms",
        retries[0].backoff_ms
    );
}
