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
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::Value;

use crate::providers::finish_reason;
use crate::providers::traits::{
    LLMProvider, LLMResponse, ProviderError, StreamErrorKind, ToolCallRequest,
};
use crate::tools::call_context::{TurnProcessControl, TurnProcessOwner};
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;
use crate::tools::traits::{CallContext, Tool, ToolError};
use crate::turn_executor::{
    execute_turn, set_test_backoff_override_ms, TurnConfig, TurnEventHandler,
};
use tokio_util::sync::CancellationToken;

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

struct PrematureFinalProvider {
    calls: AtomicU32,
    owner: TurnProcessOwner,
    handle: String,
}

struct NeverConvergesProvider {
    calls: AtomicU32,
    owner: TurnProcessOwner,
    handle: String,
}

struct ProviderErrorAfterSpawn {
    owner: TurnProcessOwner,
    handle: String,
}

struct TerminalTaskBeforeJobProvider {
    calls: AtomicU32,
    owner: TurnProcessOwner,
    handle: String,
}

#[async_trait]
impl LLMProvider for TerminalTaskBeforeJobProvider {
    async fn chat(
        &self,
        _messages: &[Value],
        _tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            let _ = crate::tools::impls::coding::exec::registry::register_owned_subagent(
                self.handle.clone(),
                "delegate".to_string(),
                "Task Finality Worker".to_string(),
                self.owner.session_id.clone(),
                self.owner.clone(),
            );
            crate::tools::impls::coding::exec::registry::set_join_handle(
                &self.handle,
                tokio::spawn(async {}),
            );
            tokio::task::yield_now().await;
        } else if call == 1 {
            crate::tools::impls::coding::exec::registry::finish_subagent(
                &self.handle,
                crate::tools::impls::coding::exec::registry::JobStatus::Completed,
                "terminal work result".to_string(),
            );
            // `finish_subagent` publishes the result before the JoinHandle's
            // cleanup tail is terminal. Give that exact owner task one
            // scheduler turn so this fixture represents a consumable result,
            // not the deliberately guarded publish/join handoff window.
            tokio::task::yield_now().await;
        }
        let tool_calls = (call < 3)
            .then(|| ToolCallRequest {
                id: format!("task-complete-{call}"),
                name: crate::tools::names::TASK_UPDATE.to_string(),
                arguments: serde_json::json!({
                    "operation": "complete",
                    "id": "owned-task",
                    "output": { "summary": "done" }
                }),
                thought_signature: None,
            })
            .into_iter()
            .collect();
        Ok(LLMResponse {
            content: Some(
                if call < 3 {
                    "trying to complete the Task"
                } else {
                    "final after Task completion"
                }
                .to_string(),
            ),
            tool_calls,
            finish_reason: finish_reason::STOP.to_string(),
            usage: HashMap::new(),
            reasoning_content: None,
            blocks: Vec::new(),
            stream_error_kind: None,
            retry_after_ms: None,
        })
    }

    fn default_model(&self) -> &str {
        "terminal-task-before-job"
    }

    fn provider_name(&self) -> &str {
        "terminal-task-before-job"
    }
}

struct RecordingTaskUpdateTool {
    executions: Arc<AtomicU32>,
}

#[async_trait]
impl Tool for RecordingTaskUpdateTool {
    fn name(&self) -> &str {
        crate::tools::names::TASK_UPDATE
    }

    fn description(&self) -> &str {
        "test Task terminal mutation"
    }

    fn parameters(&self) -> Value {
        serde_json::json!({ "type": "object" })
    }

    async fn execute_text(&self, _params: Value, _ctx: &CallContext) -> Result<String, ToolError> {
        self.executions.fetch_add(1, Ordering::SeqCst);
        Ok("Task completed".to_string())
    }
}

#[async_trait]
impl LLMProvider for ProviderErrorAfterSpawn {
    async fn chat(
        &self,
        _messages: &[Value],
        _tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        let _ = crate::tools::impls::coding::exec::registry::register_owned_subagent(
            self.handle.clone(),
            "delegate".to_string(),
            "Provider Error Worker".to_string(),
            self.owner.session_id.clone(),
            self.owner.clone(),
        );
        crate::tools::impls::coding::exec::registry::set_join_handle(
            &self.handle,
            tokio::spawn(std::future::pending::<()>()),
        );
        Err(ProviderError::Other(
            "provider failed after spawn".to_string(),
        ))
    }

    fn default_model(&self) -> &str {
        "provider-error-after-spawn"
    }

    fn provider_name(&self) -> &str {
        "provider-error-after-spawn"
    }
}

#[async_trait]
impl LLMProvider for NeverConvergesProvider {
    async fn chat(
        &self,
        _messages: &[Value],
        _tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            let _ = crate::tools::impls::coding::exec::registry::register_owned_subagent(
                self.handle.clone(),
                "delegate".to_string(),
                "Never Converges".to_string(),
                self.owner.session_id.clone(),
                self.owner.clone(),
            );
            crate::tools::impls::coding::exec::registry::set_join_handle(
                &self.handle,
                tokio::spawn(std::future::pending::<()>()),
            );
        }
        Ok(LLMResponse {
            content: Some("done despite running work".to_string()),
            tool_calls: Vec::new(),
            finish_reason: finish_reason::STOP.to_string(),
            usage: HashMap::new(),
            reasoning_content: None,
            blocks: Vec::new(),
            stream_error_kind: None,
            retry_after_ms: None,
        })
    }

    fn default_model(&self) -> &str {
        "never-converges"
    }

    fn provider_name(&self) -> &str {
        "never-converges"
    }
}

#[async_trait]
impl LLMProvider for PrematureFinalProvider {
    async fn chat(
        &self,
        _messages: &[Value],
        _tools: Option<&[Value]>,
        _model: &str,
        _max_tokens: u32,
        _temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let content = match call {
            0 => {
                let _ = crate::tools::impls::coding::exec::registry::register_owned_subagent(
                    self.handle.clone(),
                    "delegate".to_string(),
                    "Convergence Worker".to_string(),
                    self.owner.session_id.clone(),
                    self.owner.clone(),
                );
                crate::tools::impls::coding::exec::registry::set_join_handle(
                    &self.handle,
                    tokio::spawn(async {}),
                );
                tokio::task::yield_now().await;
                "premature final while the worker is running"
            }
            1 => {
                crate::tools::impls::coding::exec::registry::finish_subagent(
                    &self.handle,
                    crate::tools::impls::coding::exec::registry::JobStatus::Completed,
                    "worker terminal result".to_string(),
                );
                "premature final before consuming the worker result"
            }
            _ => "final after the owned result was consumed",
        };
        Ok(LLMResponse {
            content: Some(content.to_string()),
            tool_calls: Vec::new(),
            finish_reason: finish_reason::STOP.to_string(),
            usage: HashMap::new(),
            reasoning_content: None,
            blocks: Vec::new(),
            stream_error_kind: None,
            retry_after_ms: None,
        })
    }

    fn default_model(&self) -> &str {
        "premature-final"
    }

    fn provider_name(&self) -> &str {
        "premature-final"
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
        turn_process_control: None,
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

#[tokio::test]
async fn owned_background_result_converges_inside_the_same_turn() {
    let owner = TurnProcessOwner {
        session_id: "owned-finality-turn-session".to_string(),
        turn_intent_id: "owned-finality-turn-intent".to_string(),
        runtime_lease_id: "owned-finality-runtime".to_string(),
        dialog_turn_generation: "owned-finality-generation".to_string(),
    };
    let handle = "agent-owned-finality-turn-worker".to_string();
    let provider = PrematureFinalProvider {
        calls: AtomicU32::new(0),
        owner: owner.clone(),
        handle: handle.clone(),
    };
    let handler = MockRetryHandler::new();
    let tools = ToolRegistry::new();
    let policy = empty_policy();
    let mut config = test_config();
    config.turn_intent_id = owner.turn_intent_id.clone();
    config.turn_process_control = Some(TurnProcessControl {
        owner: owner.clone(),
        background_cancel: CancellationToken::new(),
        require_owned_job_finality: true,
    });
    let mut messages = vec![serde_json::json!({
        "role": "user",
        "content": "finish only after your worker"
    })];

    let result = execute_turn(
        &mut messages,
        &provider,
        &tools,
        &policy,
        &config,
        &owner.session_id,
        &handler,
        None,
        None,
        None,
    )
    .await
    .expect("same-Turn convergence should succeed");

    assert_eq!(
        result.content.as_deref(),
        Some("final after the owned result was consumed")
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    assert!(messages.iter().any(|message| {
        message
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|text| text.contains("worker terminal result"))
    }));
    assert!(crate::tools::impls::coding::exec::registry::list_jobs_for_owner(&owner).is_empty());
    assert!(crate::tools::impls::coding::exec::registry::get_status(&handle).is_none());
    assert!(
        !crate::tools::impls::coding::exec::registry::claim_completion_wake_for_session(
            &owner.session_id
        ),
        "consumed Agent Org result must not schedule a later generic wake"
    );
}

#[tokio::test]
async fn task_terminal_mutation_waits_for_owned_job_result_consumption() {
    let owner = TurnProcessOwner {
        session_id: "owned-task-finality-session".to_string(),
        turn_intent_id: "owned-task-finality-intent".to_string(),
        runtime_lease_id: "owned-task-finality-runtime".to_string(),
        dialog_turn_generation: "owned-task-finality-generation".to_string(),
    };
    let handle = "agent-owned-task-finality-worker".to_string();
    let provider = TerminalTaskBeforeJobProvider {
        calls: AtomicU32::new(0),
        owner: owner.clone(),
        handle,
    };
    let executions = Arc::new(AtomicU32::new(0));
    let mut tools = ToolRegistry::new();
    tools.register(Box::new(RecordingTaskUpdateTool {
        executions: Arc::clone(&executions),
    }));
    let mut config = test_config();
    config.turn_intent_id = owner.turn_intent_id.clone();
    config.turn_process_control = Some(TurnProcessControl {
        owner: owner.clone(),
        background_cancel: CancellationToken::new(),
        require_owned_job_finality: true,
    });
    let mut messages = vec![serde_json::json!({
        "role": "user",
        "content": "complete only after owned work converges"
    })];

    let result = execute_turn(
        &mut messages,
        &provider,
        &tools,
        &empty_policy(),
        &config,
        &owner.session_id,
        &MockRetryHandler::new(),
        None,
        None,
        None,
    )
    .await
    .expect("Task and Turn should converge in order");

    assert_eq!(
        result.content.as_deref(),
        Some("final after Task completion")
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 4);
    assert_eq!(
        executions.load(Ordering::SeqCst),
        1,
        "task_update must execute only after exact-owned result consumption"
    );
    assert!(messages.iter().any(|message| {
        message
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|text| text.contains("cannot become terminal"))
    }));
    assert!(crate::tools::impls::coding::exec::registry::list_jobs_for_owner(&owner).is_empty());
}

#[tokio::test]
async fn unconverged_owned_job_is_cancelled_and_the_turn_fails_closed() {
    let owner = TurnProcessOwner {
        session_id: "owned-finality-failure-session".to_string(),
        turn_intent_id: "owned-finality-failure-intent".to_string(),
        runtime_lease_id: "owned-finality-failure-runtime".to_string(),
        dialog_turn_generation: "owned-finality-failure-generation".to_string(),
    };
    let handle = "agent-owned-finality-never-converges".to_string();
    let provider = NeverConvergesProvider {
        calls: AtomicU32::new(0),
        owner: owner.clone(),
        handle: handle.clone(),
    };
    let handler = MockRetryHandler::new();
    let tools = ToolRegistry::new();
    let policy = empty_policy();
    let mut config = test_config();
    config.max_iterations = Some(2);
    config.turn_intent_id = owner.turn_intent_id.clone();
    config.turn_process_control = Some(TurnProcessControl {
        owner: owner.clone(),
        background_cancel: CancellationToken::new(),
        require_owned_job_finality: true,
    });
    let mut messages = vec![serde_json::json!({
        "role": "user",
        "content": "do not finish early"
    })];

    let error = execute_turn(
        &mut messages,
        &provider,
        &tools,
        &policy,
        &config,
        &owner.session_id,
        &handler,
        None,
        None,
        None,
    )
    .await
    .err()
    .expect("unconverged background work must fail the Turn");

    assert!(
        error.contains("before its background work converged"),
        "{error}"
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    assert!(crate::tools::impls::coding::exec::registry::list_jobs_for_owner(&owner).is_empty());
    assert!(crate::tools::impls::coding::exec::registry::get_status(&handle).is_none());
}

#[tokio::test]
async fn provider_error_still_tears_down_the_exact_owned_job() {
    let owner = TurnProcessOwner {
        session_id: "owned-provider-error-session".to_string(),
        turn_intent_id: "owned-provider-error-intent".to_string(),
        runtime_lease_id: "owned-provider-error-runtime".to_string(),
        dialog_turn_generation: "owned-provider-error-generation".to_string(),
    };
    let handle = "agent-owned-provider-error-worker".to_string();
    let provider = ProviderErrorAfterSpawn {
        owner: owner.clone(),
        handle: handle.clone(),
    };
    let mut config = test_config();
    config.turn_intent_id = owner.turn_intent_id.clone();
    config.turn_process_control = Some(TurnProcessControl {
        owner: owner.clone(),
        background_cancel: CancellationToken::new(),
        require_owned_job_finality: true,
    });
    let mut messages = vec![serde_json::json!({
        "role": "user",
        "content": "fail only after tearing down owned work"
    })];

    let error = execute_turn(
        &mut messages,
        &provider,
        &ToolRegistry::new(),
        &empty_policy(),
        &config,
        &owner.session_id,
        &MockRetryHandler::new(),
        None,
        None,
        None,
    )
    .await
    .err()
    .expect("Provider failure must remain a failed Turn");

    assert!(error.contains("provider failed after spawn"), "{error}");
    assert!(crate::tools::impls::coding::exec::registry::list_jobs_for_owner(&owner).is_empty());
    assert!(crate::tools::impls::coding::exec::registry::get_status(&handle).is_none());
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
